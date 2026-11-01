import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

// One phone format everywhere: E.164, e.g. "+919876543210", "+447911123456".
// Admins type numbers in many ways ("98765 43210", "07911 123456", "+1 (415) 555-0100"),
// and the same driver must always end up as the same string, so we save and compare only E.164.
//
// defaultCountry is used only when the input has no "+<country code>" (e.g. an admin typing a
// local number). Use the tenant's country, e.g. "IN", "GB", "AE".
export function normalizePhone(
    input: string,
    defaultCountry: CountryCode,
): string {
    // TODO: parse `input` with parsePhoneNumberFromString, passing defaultCountry.
    const p = parsePhoneNumberFromString(input, defaultCountry);
    // TODO: if parsing gave nothing, or the number is not valid, throw an Error that includes the input.
    if (!p || !p.isValid()) {
        throw new Error(`${input} is invalid number`);
    }
    // TODO: otherwise return the E.164 form of the parsed number.
    return p.number;
}
