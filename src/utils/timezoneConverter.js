/**
 * Timezone Converter Utility
 *
 * Converts between IANA timezone names (used by Google Calendar)
 * and Windows timezone names (used by Microsoft Graph Calendar).
 *
 * Based on Unicode CLDR windowsZones.xml mapping:
 * https://github.com/unicode-org/cldr/blob/main/common/supplemental/windowsZones.xml
 *
 * @module timezoneConverter
 */

/**
 * Complete mapping from IANA timezone names to Windows timezone names
 * Based on CLDR windowsZones.xml (2025 version)
 */
const ianaToWindowsMap = {
  // Europe
  'Europe/Prague': 'Central Europe Standard Time',
  'Europe/Berlin': 'W. Europe Standard Time',
  'Europe/Paris': 'Romance Standard Time',
  'Europe/Rome': 'W. Europe Standard Time',
  'Europe/London': 'GMT Standard Time',
  'Europe/Amsterdam': 'W. Europe Standard Time',
  'Europe/Brussels': 'Romance Standard Time',
  'Europe/Vienna': 'W. Europe Standard Time',
  'Europe/Warsaw': 'Central European Standard Time',
  'Europe/Budapest': 'Central Europe Standard Time',
  'Europe/Athens': 'GTB Standard Time',
  'Europe/Istanbul': 'Turkey Standard Time',
  'Europe/Moscow': 'Russian Standard Time',
  'Europe/Kiev': 'FLE Standard Time',
  'Europe/Bucharest': 'GTB Standard Time',
  'Europe/Sofia': 'FLE Standard Time',
  'Europe/Helsinki': 'FLE Standard Time',
  'Europe/Stockholm': 'W. Europe Standard Time',
  'Europe/Copenhagen': 'Romance Standard Time',
  'Europe/Oslo': 'W. Europe Standard Time',
  'Europe/Lisbon': 'GMT Standard Time',
  'Europe/Madrid': 'Romance Standard Time',
  'Europe/Zurich': 'W. Europe Standard Time',
  'Europe/Dublin': 'GMT Standard Time',

  // Americas - North America
  'America/New_York': 'Eastern Standard Time',
  'America/Chicago': 'Central Standard Time',
  'America/Denver': 'Mountain Standard Time',
  'America/Los_Angeles': 'Pacific Standard Time',
  'America/Phoenix': 'US Mountain Standard Time',
  'America/Anchorage': 'Alaskan Standard Time',
  'America/Honolulu': 'Hawaiian Standard Time',
  'America/Toronto': 'Eastern Standard Time',
  'America/Vancouver': 'Pacific Standard Time',
  'America/Edmonton': 'Mountain Standard Time',
  'America/Winnipeg': 'Central Standard Time',
  'America/Halifax': 'Atlantic Standard Time',
  'America/St_Johns': 'Newfoundland Standard Time',

  // Americas - Mexico
  'America/Mexico_City': 'Central Standard Time (Mexico)',
  'America/Cancun': 'Eastern Standard Time (Mexico)',
  'America/Tijuana': 'Pacific Standard Time (Mexico)',

  // Americas - Central America
  'America/Guatemala': 'Central America Standard Time',
  'America/San_Jose': 'Central America Standard Time',
  'America/Panama': 'SA Pacific Standard Time',

  // Americas - Caribbean
  'America/Havana': 'Cuba Standard Time',
  'America/Port-au-Prince': 'Haiti Standard Time',
  'America/Santo_Domingo': 'SA Western Standard Time',

  // Americas - South America
  'America/Sao_Paulo': 'E. South America Standard Time',
  'America/Buenos_Aires': 'Argentina Standard Time',
  'America/Bogota': 'SA Pacific Standard Time',
  'America/Lima': 'SA Pacific Standard Time',
  'America/Santiago': 'Pacific SA Standard Time',
  'America/Caracas': 'Venezuela Standard Time',
  'America/La_Paz': 'SA Western Standard Time',
  'America/Montevideo': 'Montevideo Standard Time',

  // Asia - East Asia
  'Asia/Tokyo': 'Tokyo Standard Time',
  'Asia/Seoul': 'Korea Standard Time',
  'Asia/Shanghai': 'China Standard Time',
  'Asia/Hong_Kong': 'China Standard Time',
  'Asia/Taipei': 'Taipei Standard Time',
  'Asia/Beijing': 'China Standard Time',

  // Asia - Southeast Asia
  'Asia/Singapore': 'Singapore Standard Time',
  'Asia/Bangkok': 'SE Asia Standard Time',
  'Asia/Jakarta': 'SE Asia Standard Time',
  'Asia/Manila': 'Singapore Standard Time',
  'Asia/Ho_Chi_Minh': 'SE Asia Standard Time',
  'Asia/Kuala_Lumpur': 'Singapore Standard Time',

  // Asia - South Asia
  'Asia/Kolkata': 'India Standard Time',
  'Asia/Mumbai': 'India Standard Time',
  'Asia/Dhaka': 'Bangladesh Standard Time',
  'Asia/Karachi': 'Pakistan Standard Time',
  'Asia/Colombo': 'Sri Lanka Standard Time',
  'Asia/Kathmandu': 'Nepal Standard Time',

  // Asia - Central Asia
  'Asia/Almaty': 'Central Asia Standard Time',
  'Asia/Tashkent': 'West Asia Standard Time',
  'Asia/Yekaterinburg': 'Ekaterinburg Standard Time',

  // Asia - Middle East
  'Asia/Dubai': 'Arabian Standard Time',
  'Asia/Riyadh': 'Arab Standard Time',
  'Asia/Kuwait': 'Arab Standard Time',
  'Asia/Doha': 'Arab Standard Time',
  'Asia/Muscat': 'Arabian Standard Time',
  'Asia/Bahrain': 'Arab Standard Time',
  'Asia/Tehran': 'Iran Standard Time',
  'Asia/Baghdad': 'Arabic Standard Time',
  'Asia/Jerusalem': 'Israel Standard Time',
  'Asia/Beirut': 'Middle East Standard Time',
  'Asia/Damascus': 'Syria Standard Time',
  'Asia/Amman': 'Jordan Standard Time',

  // Pacific - Australia
  'Australia/Sydney': 'AUS Eastern Standard Time',
  'Australia/Melbourne': 'AUS Eastern Standard Time',
  'Australia/Brisbane': 'E. Australia Standard Time',
  'Australia/Perth': 'W. Australia Standard Time',
  'Australia/Adelaide': 'Cen. Australia Standard Time',
  'Australia/Darwin': 'AUS Central Standard Time',
  'Australia/Hobart': 'Tasmania Standard Time',

  // Pacific - New Zealand
  'Pacific/Auckland': 'New Zealand Standard Time',
  'Pacific/Fiji': 'Fiji Standard Time',

  // Pacific - Islands
  'Pacific/Honolulu': 'Hawaiian Standard Time',
  'Pacific/Guam': 'West Pacific Standard Time',
  'Pacific/Port_Moresby': 'West Pacific Standard Time',
  'Pacific/Tongatapu': 'Tonga Standard Time',

  // Africa
  'Africa/Cairo': 'Egypt Standard Time',
  'Africa/Johannesburg': 'South Africa Standard Time',
  'Africa/Nairobi': 'E. Africa Standard Time',
  'Africa/Lagos': 'W. Central Africa Standard Time',
  'Africa/Casablanca': 'Morocco Standard Time',

  // Atlantic
  'Atlantic/Reykjavik': 'Greenwich Standard Time',
  'Atlantic/Azores': 'Azores Standard Time',
  'Atlantic/Cape_Verde': 'Cape Verde Standard Time',

  // UTC and variants
  'UTC': 'UTC',
  'Etc/UTC': 'UTC',
  'Etc/GMT': 'UTC',
  'GMT': 'UTC',
};

/**
 * Converts IANA timezone name to Windows timezone name
 *
 * @param {string} ianaTimezone - IANA timezone name (e.g., 'Europe/Prague')
 * @returns {string} Windows timezone name (e.g., 'Central Europe Standard Time')
 *
 * @example
 * convertIANAToWindows('Europe/Prague')
 * // Returns: 'Central Europe Standard Time'
 *
 * convertIANAToWindows('America/New_York')
 * // Returns: 'Eastern Standard Time'
 */
export function convertIANAToWindows(ianaTimezone) {
  if (!ianaTimezone) {
    console.warn('⚠️ Empty IANA timezone provided, using UTC');
    return 'UTC';
  }

  const windowsTimezone = ianaToWindowsMap[ianaTimezone];

  if (!windowsTimezone) {
    console.warn(`⚠️ Unknown IANA timezone: ${ianaTimezone}, falling back to UTC`);
    return 'UTC';
  }

  return windowsTimezone;
}

/**
 * Converts Windows timezone name to IANA timezone name
 *
 * Note: Multiple IANA timezones can map to the same Windows timezone.
 * This function returns the primary/representative IANA timezone for each Windows timezone.
 *
 * @param {string} windowsTimezone - Windows timezone name (e.g., 'Central Europe Standard Time')
 * @returns {string} IANA timezone name (e.g., 'Europe/Prague')
 *
 * @example
 * convertWindowsToIANA('Central Europe Standard Time')
 * // Returns: 'Europe/Prague'
 *
 * convertWindowsToIANA('Eastern Standard Time')
 * // Returns: 'America/New_York'
 */
export function convertWindowsToIANA(windowsTimezone) {
  if (!windowsTimezone) {
    console.warn('⚠️ Empty Windows timezone provided, using UTC');
    return 'UTC';
  }

  // Build reverse map (Windows -> IANA)
  // For timezones with multiple IANA mappings, the first one wins (primary timezone)
  const reverseMap = {};
  for (const [iana, windows] of Object.entries(ianaToWindowsMap)) {
    if (!reverseMap[windows]) {
      reverseMap[windows] = iana; // First occurrence = primary
    }
  }

  const ianaTimezone = reverseMap[windowsTimezone];

  if (!ianaTimezone) {
    console.warn(`⚠️ Unknown Windows timezone: ${windowsTimezone}, falling back to UTC`);
    return 'UTC';
  }

  return ianaTimezone;
}

/**
 * Validates if a timezone name is a valid IANA timezone
 *
 * @param {string} timezone - Timezone name to validate
 * @returns {boolean} True if valid IANA timezone
 *
 * @example
 * isValidIANATimezone('Europe/Prague')  // Returns: true
 * isValidIANATimezone('Invalid/Zone')   // Returns: false
 */
export function isValidIANATimezone(timezone) {
  return timezone in ianaToWindowsMap;
}

/**
 * Validates if a timezone name is a valid Windows timezone
 *
 * @param {string} timezone - Timezone name to validate
 * @returns {boolean} True if valid Windows timezone
 *
 * @example
 * isValidWindowsTimezone('Central Europe Standard Time')  // Returns: true
 * isValidWindowsTimezone('Invalid Timezone')              // Returns: false
 */
export function isValidWindowsTimezone(timezone) {
  return Object.values(ianaToWindowsMap).includes(timezone);
}

/**
 * Gets all supported IANA timezones
 *
 * @returns {string[]} Array of IANA timezone names
 */
export function getSupportedIANATimezones() {
  return Object.keys(ianaToWindowsMap);
}

/**
 * Gets all supported Windows timezones
 *
 * @returns {string[]} Array of unique Windows timezone names
 */
export function getSupportedWindowsTimezones() {
  return [...new Set(Object.values(ianaToWindowsMap))];
}

/**
 * Converts a datetime object with IANA timezone to Microsoft Graph format
 *
 * @param {Object} dateTime - DateTime object with IANA timezone
 * @param {string} dateTime.dateTime - ISO 8601 datetime string
 * @param {string} dateTime.timeZone - IANA timezone name
 * @returns {Object} DateTime object with Windows timezone
 *
 * @example
 * convertDateTimeToMicrosoft({
 *   dateTime: '2025-11-20T10:00:00',
 *   timeZone: 'Europe/Prague'
 * })
 * // Returns: {
 * //   dateTime: '2025-11-20T10:00:00',
 * //   timeZone: 'Central Europe Standard Time'
 * // }
 */
export function convertDateTimeToMicrosoft(dateTime) {
  return {
    dateTime: dateTime.dateTime,
    timeZone: convertIANAToWindows(dateTime.timeZone)
  };
}

/**
 * Converts a datetime object with Windows timezone to Google Calendar format
 *
 * @param {Object} dateTime - DateTime object with Windows timezone
 * @param {string} dateTime.dateTime - ISO 8601 datetime string
 * @param {string} dateTime.timeZone - Windows timezone name
 * @returns {Object} DateTime object with IANA timezone
 *
 * @example
 * convertDateTimeToGoogle({
 *   dateTime: '2025-11-20T10:00:00',
 *   timeZone: 'Central Europe Standard Time'
 * })
 * // Returns: {
 * //   dateTime: '2025-11-20T10:00:00',
 * //   timeZone: 'Europe/Prague'
 * // }
 */
export function convertDateTimeToGoogle(dateTime) {
  return {
    dateTime: dateTime.dateTime,
    timeZone: convertWindowsToIANA(dateTime.timeZone)
  };
}

/**
 * Get current system timezone in both IANA and Windows format
 *
 * @returns {Object} Object with both timezone formats
 *
 * @example
 * getSystemTimezone()
 * // Returns: {
 * //   iana: 'Europe/Prague',
 * //   windows: 'Central Europe Standard Time'
 * // }
 */
export function getSystemTimezone() {
  // Try to detect system timezone
  let ianaTimezone;

  try {
    ianaTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error) {
    console.warn('Could not detect system timezone, using UTC');
    ianaTimezone = 'UTC';
  }

  return {
    iana: ianaTimezone,
    windows: convertIANAToWindows(ianaTimezone)
  };
}
