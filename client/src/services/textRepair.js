/**
 * Repairs Turkish text corrupted by one of two historical codepage-mismatch
 * bugs seen in stored/relayed emergency-broadcast and meeting-notification
 * strings. NOT a live bug in the current pipeline: the server (socket.js,
 * email.js) already emits correct UTF-8 for every string these lists
 * target, and no encoding conversion exists anywhere else in this codebase
 * -- the corruption predates the current code and lives in already-stored
 * data (or came from an old client/notification API on the sending side).
 * If fresh corruption shows up, look at the sender, not here.
 *
 * These were previously duplicated verbatim in both DashboardPage.jsx and
 * EmergencyButton.jsx; this is that same, unchanged mapping in one place.
 * The character-pair form (not a generic byte round-trip) is kept
 * deliberately -- Windows-1252's upper range (0x80-0x9F) doesn't map
 * 1:1 onto Unicode code points the way the rest of Latin-1 does, so a
 * generic re-decode gets that range wrong without real corrupted samples
 * to validate against. These specific pairs are already proven correct
 * against the actual corrupted strings this app has seen.
 */

// Mode A: UTF-8 bytes that got read back as Latin-1/Windows-1252.
const UTF8_AS_LATIN1_PAIRS = [
  ['Ã§', 'ç'], ['Ã‡', 'Ç'], ['Ã¶', 'ö'], ['Ã–', 'Ö'], ['Ã¼', 'ü'], ['Ãœ', 'Ü'],
  ['Ä±', 'ı'], ['Ä°', 'İ'], ['ÅŸ', 'ş'], ['Åž', 'Ş'], ['ÄŸ', 'ğ'], ['Äž', 'Ğ'],
];

// Mode B: Windows-1254 (Turkish codepage) bytes that got read back as
// Latin-1 -- e.g. Windows-1254's 'ı' (byte 0xFD) reads as Latin-1's 'ý'.
const WIN1254_AS_LATIN1_PAIRS = [
  ['ý', 'ı'], ['Ý', 'İ'], ['þ', 'ş'], ['Þ', 'Ş'], ['ð', 'ğ'], ['Ð', 'Ğ'],
];

// Entries where the original byte was already replaced by U+FFFD before
// storage -- genuinely unrecoverable; reconstructed from context for the
// handful of stock meeting-notification phrases known to have hit this.
// Do not extend this list for new corruption -- if fresh U+FFFD text shows
// up, the data loss is happening upstream, not fixable here.
const LOST_BYTE_PHRASES = [
  ['g�r�nt�l�', 'görüntülü'], ['G�r�nt�l�', 'Görüntülü'],
  ['toplant�y�', 'toplantıyı'], ['toplant�ya', 'toplantıya'],
  ['toplant�dan', 'toplantıdan'], ['toplant�', 'toplantı'],
  ['ba�latt�', 'başlattı'], ['ba�lat�ld�', 'başlatıldı'], ['ba�lat', 'başlat'],
  ['kat�ld�', 'katıldı'], ['kat�l�mc�', 'katılımcı'], ['kat�l', 'katıl'],
  ['ayr�ld�', 'ayrıldı'], ['ayr�l', 'ayrıl'],
  ['Mesajla�ma', 'Mesajlaşma'],
];

// Entries where Turkish diacritics were stripped to their closest ASCII
// letter (ı→i, ş→s, ğ→g, ...) somewhere upstream -- inherently ambiguous
// (an ASCII word here could be a genuine word or a stripped one), so this
// stays an explicit lookup rather than a generic transform.
const ASCII_STRIPPED_PHRASES = [
  ['goruntulu', 'görüntülü'], ['Goruntulu', 'Görüntülü'],
  ['toplanti', 'toplantı'], ['toplantiyi', 'toplantıyı'], ['toplantiya', 'toplantıya'], ['toplantidan', 'toplantıdan'],
  ['baslatildi', 'başlatıldı'], ['Baslatildi', 'Başlatıldı'], ['baslat', 'başlat'],
  ['katilabilirsiniz', 'katılabilirsiniz'], ['katil', 'katıl'],
  ['ayril', 'ayrıl'],
  ['Mesajlasma', 'Mesajlaşma'],
  ['bașlatıldı', 'başlatıldı'], ['bașlatildi', 'başlatıldı'], // 'ș' (comma-below) vs Turkish 'ş' (cedilla) mix-up
];

// Longest-broken-string-first, so a specific phrase (e.g. 'toplantiyi')
// gets replaced whole before a shorter, more general one it contains (e.g.
// 'toplanti') has a chance to partially consume it and break the match.
const ALL_PAIRS = [...UTF8_AS_LATIN1_PAIRS, ...WIN1254_AS_LATIN1_PAIRS, ...LOST_BYTE_PHRASES, ...ASCII_STRIPPED_PHRASES]
  .sort((a, b) => b[0].length - a[0].length);

export function repairLegacyText(text) {
  let s = String(text || '');
  for (const [broken, fixed] of ALL_PAIRS) s = s.replaceAll(broken, fixed);
  return s;
}
