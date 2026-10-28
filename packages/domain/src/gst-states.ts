// GST state and union-territory codes (the first two digits of a GSTIN),
// used for place of supply on printed documents.
export const GST_STATES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** A state or union territory a shop can be in: every GST code except "97 Other Territory" (D-073). */
export const isIndianStateCode = (code: string): boolean => code !== '97' && Object.hasOwn(GST_STATES, code);

/** The 28 states and 8 union territories as [code, name], sorted by name. */
export const INDIAN_STATES: readonly (readonly [string, string])[] = Object.entries(GST_STATES)
  .filter(([code]) => isIndianStateCode(code))
  .sort(([, a], [, b]) => a.localeCompare(b, 'en'));

/** "Maharashtra (27)", or just the code when unknown. */
export const stateLabel = (code: string): string => (GST_STATES[code] ? `${GST_STATES[code]} (${code})` : code);
