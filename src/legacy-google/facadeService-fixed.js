/**
 * Inbox Overview - FIXED VERSION
 * Step 1: Search for message IDs
 * Step 2: Batch fetch metadata for all messages
 * Step 3: Return enriched items with sender, subject, etc.
 */
export async function inboxOverview(googleSub, params) {
  const { timeRange, maxItems = 50, filters = {} } = params;
  
  // Build Gmail search query - search in inbox only
  // in:inbox excludes: sent, archived, trash, spam automatically
  let query = 'in:inbox -in:draft ';

  if (filters.from) {
    query += `from:${filters.from} `;
  }

  if (filters.hasAttachment) {
    query += 'has:attachment ';
  }
  
  // Handle Gmail category filters
  // IMPORTANT: category:primary returns ALL inbox (not just primary!)
  // Must use negative filters to exclude other categories
  if (filters.category) {
    const categoryLower = filters.category.toLowerCase();
    const validCategories = ['primary', 'work', 'promotions', 'social', 'updates', 'forums'];

    if (validCategories.includes(categoryLower)) {
      if (categoryLower === 'primary' || categoryLower === 'work') {
        // Primary = inbox minus other categories
        query += '-category:promotions -category:social -category:updates -category:forums ';
      } else {
        // Other categories work normally
        query += `category:${categoryLower} `;
      }
    }
  }
  
  if (filters.labelIds && filters.labelIds.length > 0) {
    query += filters.labelIds.map(id => `label:${id}`).join(' ');
  }
  
  // Add time range
  if (timeRange) {
    if (timeRange.relative) {
      const times = parseRelativeTime(timeRange.relative);
      if (times) {
        query += `after:${times.after} before:${times.before}`;
      }
    } else if (timeRange.start && timeRange.end) {
      const startSec = Math.floor(new Date(timeRange.start).getTime() / 1000);
      const endSec = Math.floor(new Date(timeRange.end).getTime() / 1000);
      query += `after:${startSec} before:${endSec}`;
    }
  }
  
  // Step 1: Search emails - returns message IDs
  const searchResults = await gmailService.searchEmails(googleSub, {
    q: query.trim(),
    maxResults: Math.min(maxItems, 200)
  });
  
  if (!searchResults.messages || searchResults.messages.length === 0) {
    return {
      items: [],
      subset: false,
      nextPageToken: null
    };
  }
  
  // Step 2: Batch fetch metadata for ALL message IDs
  const messageIds = searchResults.messages.map(m => m.id);
  const batchSize = 10; // Fetch 10 at a time to avoid rate limiting
  const enrichedMessages = [];
  
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const metadataPromises = batch.map(id =>
      gmailService.readEmail(googleSub, id, { format: 'metadata' })
        .catch(err => {
          console.error(`Failed to fetch metadata for ${id}:`, err.message);
          return null;
        })
    );
    
    const batchResults = await Promise.all(metadataPromises);
    enrichedMessages.push(...batchResults.filter(m => m !== null));
  }
  
  // Step 3: Map to standardized items
  const items = enrichedMessages.map(msg => {
    const fromHeader = msg.from || '';
    const fromEmail = extractEmail(fromHeader);
    const fromName = extractSenderName(fromHeader);
    
    return {
      messageId: msg.id,
      senderName: fromName || null,
      senderAddress: fromEmail || fromHeader,
      subject: msg.subject || '(no subject)',
      receivedAt: msg.date || null,
      inboxCategory: msg.inboxCategory || 'other',
      snippet: msg.snippet || ''
    };
  });
  
  return {
    items,
    subset: (searchResults.resultSizeEstimate || 0) > maxItems,
    nextPageToken: searchResults.nextPageToken || null
  };
}

/**
 * Inbox Snippets - overview with snippets and attachment URLs
 */
export async function inboxSnippets(googleSub, params) {
  const { includeAttachments = true } = params;
  
  // Start with overview - already has metadata
  const overview = await inboxOverview(googleSub, params);
  
  // If overview already includes snippets, just add attachment URLs if needed
  if (!includeAttachments) {
    return {
      items: overview.items,
      subset: overview.subset,
      nextPageToken: overview.nextPageToken
    };
  }
  
  // Fetch attachments for each message (attachments not in metadata call)
  const batchSize = 10;
  const enriched = [];
  
  for (let i = 0; i < overview.items.length; i += batchSize) {
    const batch = overview.items.slice(i, i + batchSize);
    const attachmentPromises = batch.map(async (item) => {
      try {
        const message = await gmailService.readEmail(googleSub, item.messageId, { format: 'full' });
        
        const enrichedItem = {
          ...item,
          attachmentUrls: []
        };
        
        if (message.payload?.parts) {
          const attachments = extractAttachmentMetadata(message.payload);
          const processed = processAttachments(attachments, (att) => 
            generateSignedAttachmentUrl(item.messageId, att.body?.attachmentId)
          );
          
          enrichedItem.attachmentUrls = processed.attachments
            .filter(a => !a.blocked && a.url)
            .map(a => a.url);
        }
        
        return enrichedItem;
      } catch (error) {
        console.error(`Failed to fetch attachments for ${item.messageId}:`, error.message);
        return {
          ...item,
          attachmentUrls: []
        };
      }
    });
    
    const batchResults = await Promise.all(attachmentPromises);
    enriched.push(...batchResults);
  }
  
  return {
    items: enriched,
    subset: overview.subset,
    nextPageToken: overview.nextPageToken
  };
}

/**
 * Helper: Extract email from "Name <email@example.com>"
 */
function extractEmail(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<(.+?)>/);
  return match ? match[1] : fromHeader.trim();
}

/**
 * Helper: Extract name from "Name <email@example.com>"
 */
function extractSenderName(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/^(.+?)\s*<(.+?)>/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, '');
    return name || null;
  }
  // If no angle brackets, return as-is (or null if it looks like email)
  return fromHeader.includes('@') ? null : fromHeader.trim();
}
