import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import { refreshAccessToken } from '../config/microsoft.js';
import dotenv from 'dotenv';
import { wrapModuleFunctions } from '../utils/advancedDebugging.js';
import { mapGoogleApiError } from './serviceErrors.js';
import XLSX from 'xlsx-js-style';

dotenv.config();

/**
 * Contacts Service - Excel Online Storage
 *
 * ✅ EXCEL ONLY - NO MONGODB
 * All contact data is stored in Excel file in OneDrive.
 * Authentication tokens are passed from caller (controller/RPC).
 *
 * Replaces Google Sheets with Microsoft Excel Online
 * STRUCTURE: Name | Email | Phone | RealEstate | Notes
 */

const CONTACTS_FILE_NAME = 'Alfred Kontakty.xlsx';
const CONTACTS_WORKSHEET_NAME = 'Contacts';
const CONTACTS_RANGE = 'A2:E10000'; // Data rows (excluding header)
const CONTACTS_HEADER_RANGE = 'A1:E1';
const CONTACTS_EXPECTED_HEADERS = ['Name', 'Email', 'Phone', 'RealEstate', 'Notes'];
const GPT_RETRY_EXAMPLE_EMAIL = 'alex@example.com';

/**
 * Get authenticated Microsoft Graph client
 */
async function getGraphClient(accessToken) {
  try {
    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });
  } catch (error) {
    console.error('❌ [GRAPH_ERROR] Failed to get Graph client');
    throw mapGoogleApiError(error, {
      message: 'Failed to get Graph client - check Microsoft API credentials and scopes',
      details: { operation: 'getGraphClient' }
    });
  }
}

/**
 * Find contacts Excel file by name
 */
async function findContactsFile(accessToken) {
  try {
    const client = await getGraphClient(accessToken);

    // Search for the file in user's OneDrive
    const response = await client.api('/me/drive/root/search')
      .query({
        q: CONTACTS_FILE_NAME
      })
      .get();

    const files = response.value || [];
    const contactsFile = files.find(f =>
      f.name === CONTACTS_FILE_NAME &&
      !f.deleted &&
      (f.file?.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
       f.package?.type === 'oneNote')
    );

    return contactsFile?.id || null;

  } catch (error) {
    console.error('❌ [DRIVE_ERROR] Failed to find contacts file');
    throw mapGoogleApiError(error, {
      message: 'Failed to find contacts file in OneDrive. You may need to re-authorize to grant OneDrive access.',
      details: {
        operation: 'findContactsFile',
        fileName: CONTACTS_FILE_NAME,
        hint: 'This error often occurs when the access token lacks Files.ReadWrite scopes. User needs to re-authenticate.'
      }
    });
  }
}

/**
 * Create contacts Excel file with headers
 */
async function createContactsFile(accessToken) {
  try {
    console.log(`📝 Creating new contacts file: ${CONTACTS_FILE_NAME}`);

    const client = await getGraphClient(accessToken);

    // Create workbook with headers
    const workbook = XLSX.utils.book_new();
    const headers = [CONTACTS_EXPECTED_HEADERS];
    const worksheet = XLSX.utils.aoa_to_sheet(headers);
    XLSX.utils.book_append_sheet(workbook, worksheet, CONTACTS_WORKSHEET_NAME);

    // Convert to buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Upload to OneDrive
    const uploadResponse = await client.api(`/me/drive/root:/${CONTACTS_FILE_NAME}:/content`)
      .put(buffer);

    console.log(`✅ Contacts file created successfully: ${uploadResponse.id}`);

    return uploadResponse.id;

  } catch (error) {
    console.error('❌ Failed to create contacts file');
    throw mapGoogleApiError(error, {
      message: 'Failed to create contacts Excel file in OneDrive',
      details: {
        operation: 'createContactsFile',
        fileName: CONTACTS_FILE_NAME
      }
    });
  }
}

/**
 * Get or create contacts file
 */
async function getOrCreateContactsFile(accessToken) {
  try {
    let fileId = await findContactsFile(accessToken);

    if (!fileId) {
      console.log(`⚠️  Contacts file not found, creating new one...`);
      fileId = await createContactsFile(accessToken);
    }

    return fileId;

  } catch (error) {
    console.error('❌ Failed to get or create contacts file');
    throw error;
  }
}

/**
 * Get contacts file info (for debugging)
 */
async function getContactsFileInfo(accessToken) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    // Get workbook info
    const workbookResponse = await client.api(`/me/drive/items/${fileId}/workbook`)
      .get();

    // Get worksheets
    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const worksheets = worksheetsResponse.value || [];
    const contactsSheet = worksheets.find(ws => ws.name === CONTACTS_WORKSHEET_NAME);

    if (!contactsSheet) {
      throw new Error(`Worksheet "${CONTACTS_WORKSHEET_NAME}" not found in contacts file`);
    }

    // Get used range to count rows
    const usedRangeResponse = await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/usedRange`
    ).get();

    const rowCount = (usedRangeResponse.rowCount || 1) - 1; // Subtract header row

    return {
      fileId,
      fileName: CONTACTS_FILE_NAME,
      worksheetId: contactsSheet.id,
      worksheetName: contactsSheet.name,
      rowCount,
      lastModified: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Failed to get contacts file info');
    throw mapGoogleApiError(error, {
      message: 'Failed to get contacts file info',
      details: { operation: 'getContactsFileInfo' }
    });
  }
}

/**
 * Read all contacts from Excel file
 */
async function readAllContacts(accessToken) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    // Get the worksheet
    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const contactsSheet = (worksheetsResponse.value || []).find(
      ws => ws.name === CONTACTS_WORKSHEET_NAME
    );

    if (!contactsSheet) {
      throw new Error(`Worksheet "${CONTACTS_WORKSHEET_NAME}" not found`);
    }

    // Read used range (excluding header)
    const rangeResponse = await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/usedRange`
    ).get();

    const values = rangeResponse.values || [];

    // Skip header row and map to contact objects
    const contacts = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (row && row.length > 0 && (row[0] || row[1])) { // At least name or email
        contacts.push({
          name: row[0] || '',
          email: row[1] || '',
          phone: row[2] || '',
          realestate: row[3] || '',
          notes: row[4] || '',
          rowIndex: i + 1 // Excel row number (1-based, accounting for header)
        });
      }
    }

    return contacts;

  } catch (error) {
    console.error('❌ Failed to read contacts');
    throw mapGoogleApiError(error, {
      message: 'Failed to read contacts from Excel file',
      details: { operation: 'readAllContacts' }
    });
  }
}

/**
 * Search contacts by query
 */
async function searchContacts(accessToken, searchQuery) {
  try {
    if (!searchQuery || searchQuery.trim() === '') {
      return [];
    }

    const allContacts = await readAllContacts(accessToken);
    const query = searchQuery.toLowerCase().trim();

    // Search across all fields
    const results = allContacts.filter(contact => {
      return (
        (contact.name && contact.name.toLowerCase().includes(query)) ||
        (contact.email && contact.email.toLowerCase().includes(query)) ||
        (contact.phone && contact.phone.toLowerCase().includes(query)) ||
        (contact.realestate && contact.realestate.toLowerCase().includes(query)) ||
        (contact.notes && contact.notes.toLowerCase().includes(query))
      );
    });

    console.log(`🔍 Found ${results.length} contacts matching "${searchQuery}"`);

    return results.map(contact => ({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      realestate: contact.realestate,
      notes: contact.notes
    }));

  } catch (error) {
    console.error('❌ Failed to search contacts');
    throw mapGoogleApiError(error, {
      message: 'Failed to search contacts',
      details: { operation: 'searchContacts', query: searchQuery }
    });
  }
}

/**
 * Get address suggestions for autocomplete
 */
async function getAddressSuggestions(accessToken, query) {
  try {
    if (!query || query.trim() === '') {
      return [];
    }

    const allContacts = await readAllContacts(accessToken);
    const searchTerm = query.toLowerCase().trim();

    // Search by name or email, return email addresses
    const matches = allContacts.filter(contact => {
      const name = (contact.name || '').toLowerCase();
      const email = (contact.email || '').toLowerCase();
      return name.includes(searchTerm) || email.includes(searchTerm);
    });

    // Return unique email addresses
    const suggestions = [...new Set(
      matches
        .map(c => c.email)
        .filter(Boolean)
    )];

    console.log(`💡 Found ${suggestions.length} address suggestions for "${query}"`);

    return suggestions;

  } catch (error) {
    console.error('❌ Failed to get address suggestions');
    throw mapGoogleApiError(error, {
      message: 'Failed to get address suggestions',
      details: { operation: 'getAddressSuggestions', query }
    });
  }
}

/**
 * List all contacts
 */
async function listAllContacts(accessToken) {
  try {
    const allContacts = await readAllContacts(accessToken);

    console.log(`📋 Retrieved ${allContacts.length} contacts`);

    return allContacts.map(contact => ({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      realestate: contact.realestate,
      notes: contact.notes
    }));

  } catch (error) {
    console.error('❌ Failed to list contacts');
    throw mapGoogleApiError(error, {
      message: 'Failed to list all contacts',
      details: { operation: 'listAllContacts' }
    });
  }
}

/**
 * Add single contact
 */
async function addContact(accessToken, contactData) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const contactsSheet = (worksheetsResponse.value || []).find(
      ws => ws.name === CONTACTS_WORKSHEET_NAME
    );

    if (!contactsSheet) {
      throw new Error(`Worksheet "${CONTACTS_WORKSHEET_NAME}" not found`);
    }

    // Get current used range to find next empty row
    const usedRangeResponse = await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/usedRange`
    ).get();

    const nextRow = (usedRangeResponse.rowCount || 1) + 1;

    // Prepare row data
    const rowData = [
      contactData.name || '',
      contactData.email || '',
      contactData.phone || '',
      contactData.realestate || '',
      contactData.notes || ''
    ];

    // Append row
    const rangeAddress = `A${nextRow}:E${nextRow}`;
    await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/range(address='${rangeAddress}')`
    ).patch({
      values: [rowData]
    });

    console.log(`✅ Contact added: ${contactData.name} (${contactData.email})`);

    return {
      success: true,
      contact: {
        name: rowData[0],
        email: rowData[1],
        phone: rowData[2],
        realestate: rowData[3],
        notes: rowData[4]
      }
    };

  } catch (error) {
    console.error('❌ Failed to add contact');
    throw mapGoogleApiError(error, {
      message: 'Failed to add contact to Excel file',
      details: {
        operation: 'addContact',
        name: contactData?.name,
        email: contactData?.email
      }
    });
  }
}

/**
 * Bulk upsert contacts (add or update)
 */
async function bulkUpsert(accessToken, contacts) {
  try {
    if (!contacts || contacts.length === 0) {
      return { added: 0, updated: 0 };
    }

    const allContacts = await readAllContacts(accessToken);
    const emailMap = new Map(
      allContacts.map(c => [c.email.toLowerCase(), c])
    );

    let added = 0;
    let updated = 0;

    for (const contact of contacts) {
      const existing = emailMap.get(contact.email.toLowerCase());

      if (existing) {
        // Update existing
        await updateContact(accessToken, {
          email: contact.email,
          ...contact
        });
        updated++;
      } else {
        // Add new
        await addContact(accessToken, contact);
        added++;
      }
    }

    console.log(`✅ Bulk upsert complete: ${added} added, ${updated} updated`);

    return { added, updated };

  } catch (error) {
    console.error('❌ Failed to bulk upsert contacts');
    throw mapGoogleApiError(error, {
      message: 'Failed to bulk upsert contacts',
      details: { operation: 'bulkUpsert', count: contacts?.length }
    });
  }
}

/**
 * Bulk delete contacts by emails or row IDs
 */
async function bulkDelete(accessToken, { emails, rowIds }) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const contactsSheet = (worksheetsResponse.value || []).find(
      ws => ws.name === CONTACTS_WORKSHEET_NAME
    );

    if (!contactsSheet) {
      throw new Error(`Worksheet "${CONTACTS_WORKSHEET_NAME}" not found`);
    }

    let deleted = 0;

    if (emails && emails.length > 0) {
      const allContacts = await readAllContacts(accessToken);
      const emailSet = new Set(emails.map(e => e.toLowerCase()));

      const rowsToDelete = allContacts
        .filter(c => emailSet.has(c.email.toLowerCase()))
        .map(c => c.rowIndex);

      // Delete rows (from bottom to top to preserve indices)
      for (const rowIndex of rowsToDelete.sort((a, b) => b - a)) {
        await client.api(
          `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/range(address='${rowIndex}:${rowIndex}')`
        ).delete({ shift: 'Up' });
        deleted++;
      }
    }

    console.log(`✅ Bulk delete complete: ${deleted} contacts deleted`);

    return { deleted };

  } catch (error) {
    console.error('❌ Failed to bulk delete contacts');
    throw mapGoogleApiError(error, {
      message: 'Failed to bulk delete contacts',
      details: {
        operation: 'bulkDelete',
        emails: emails?.length,
        rowIds: rowIds?.length
      }
    });
  }
}

/**
 * Update single contact
 */
async function updateContact(accessToken, contactData) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    const allContacts = await readAllContacts(accessToken);
    const existing = allContacts.find(
      c => c.email.toLowerCase() === contactData.email.toLowerCase()
    );

    if (!existing) {
      throw new Error(`Contact not found: ${contactData.email}`);
    }

    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const contactsSheet = (worksheetsResponse.value || []).find(
      ws => ws.name === CONTACTS_WORKSHEET_NAME
    );

    // Update row data
    const rowData = [
      contactData.name !== undefined ? contactData.name : existing.name,
      contactData.email !== undefined ? contactData.email : existing.email,
      contactData.phone !== undefined ? contactData.phone : existing.phone,
      contactData.realestate !== undefined ? contactData.realestate : existing.realestate,
      contactData.notes !== undefined ? contactData.notes : existing.notes
    ];

    const rangeAddress = `A${existing.rowIndex}:E${existing.rowIndex}`;
    await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/range(address='${rangeAddress}')`
    ).patch({
      values: [rowData]
    });

    console.log(`✅ Contact updated: ${contactData.email}`);

    return {
      success: true,
      contact: {
        name: rowData[0],
        email: rowData[1],
        phone: rowData[2],
        realestate: rowData[3],
        notes: rowData[4]
      }
    };

  } catch (error) {
    console.error('❌ Failed to update contact');
    throw mapGoogleApiError(error, {
      message: 'Failed to update contact',
      details: { operation: 'updateContact', email: contactData?.email }
    });
  }
}

/**
 * Delete single contact by email or name
 */
async function deleteContact(accessToken, { email, name }) {
  try {
    const client = await getGraphClient(accessToken);
    const fileId = await getOrCreateContactsFile(accessToken);

    const allContacts = await readAllContacts(accessToken);

    let contactToDelete;
    if (email) {
      contactToDelete = allContacts.find(
        c => c.email.toLowerCase() === email.toLowerCase()
      );
    } else if (name) {
      contactToDelete = allContacts.find(
        c => c.name.toLowerCase() === name.toLowerCase()
      );
    }

    if (!contactToDelete) {
      throw new Error(`Contact not found: ${email || name}`);
    }

    const worksheetsResponse = await client.api(`/me/drive/items/${fileId}/workbook/worksheets`)
      .get();

    const contactsSheet = (worksheetsResponse.value || []).find(
      ws => ws.name === CONTACTS_WORKSHEET_NAME
    );

    // Delete the row
    await client.api(
      `/me/drive/items/${fileId}/workbook/worksheets/${contactsSheet.id}/range(address='${contactToDelete.rowIndex}:${contactToDelete.rowIndex}')`
    ).delete({ shift: 'Up' });

    console.log(`✅ Contact deleted: ${email || name}`);

    return { success: true, deleted: 1 };

  } catch (error) {
    console.error('❌ Failed to delete contact');
    throw mapGoogleApiError(error, {
      message: 'Failed to delete contact',
      details: { operation: 'deleteContact', email, name }
    });
  }
}

/**
 * Find duplicate contacts
 */
async function findDuplicates(accessToken) {
  try {
    const allContacts = await readAllContacts(accessToken);
    const emailMap = {};

    for (const contact of allContacts) {
      const email = contact.email.toLowerCase().trim();
      if (email) {
        if (!emailMap[email]) emailMap[email] = [];
        emailMap[email].push(contact);
      }
    }

    const duplicates = Object.values(emailMap)
      .filter(group => group.length > 1)
      .sort((a, b) => b.length - a.length);

    return {
      duplicates,
      count: duplicates.length,
      totalDuplicateContacts: duplicates.reduce((sum, group) => sum + group.length, 0)
    };

  } catch (error) {
    console.error('❌ Failed to find duplicates:', error.message);
    throw mapGoogleApiError(error, {
      message: 'Failed to find duplicates. You may need to re-authorize.',
      details: { operation: 'findDuplicates' }
    });
  }
}

const traced = wrapModuleFunctions('services.contactsService', {
  searchContacts,
  getAddressSuggestions,
  listAllContacts,
  addContact,
  bulkUpsert,
  bulkDelete,
  updateContact,
  deleteContact,
  findDuplicates,
});

const {
  searchContacts: tracedSearchContacts,
  getAddressSuggestions: tracedGetAddressSuggestions,
  listAllContacts: tracedListAllContacts,
  addContact: tracedAddContact,
  bulkUpsert: tracedBulkUpsert,
  bulkDelete: tracedBulkDelete,
  updateContact: tracedUpdateContact,
  deleteContact: tracedDeleteContact,
  findDuplicates: tracedFindDuplicates,
} = traced;

export {
  tracedSearchContacts as searchContacts,
  tracedGetAddressSuggestions as getAddressSuggestions,
  tracedListAllContacts as listAllContacts,
  tracedAddContact as addContact,
  tracedBulkUpsert as bulkUpsert,
  tracedBulkDelete as bulkDelete,
  tracedUpdateContact as updateContact,
  tracedDeleteContact as deleteContact,
  tracedFindDuplicates as findDuplicates,
};
