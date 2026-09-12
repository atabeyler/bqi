/**
 * Verifies an uploaded file's actual bytes against what its extension/MIME
 * type claims, instead of trusting the client-supplied name/mimetype alone
 * (both are attacker-controlled -- a renamed executable can claim to be
 * "report.txt" with mimetype "text/plain").
 *
 * Deliberately hand-rolled rather than pulling in a file-type-sniffing
 * dependency: the analysis upload route only ever accepts a small, fixed
 * set of formats, and each has a well-known magic-byte signature.
 */

const SIGNATURES = {
  jpeg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  // WEBP is RIFF....WEBP -- bytes 0-3 "RIFF", bytes 8-11 "WEBP".
  webp: [[0x52, 0x49, 0x46, 0x46]],
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  // .docx/.xlsx (OOXML) are ZIP archives; the empty/spanned-archive variants
  // are vanishingly unlikely for a real document but included for safety.
  zip: [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08]],
  // legacy .xls (OLE2 Compound File Binary Format)
  ole2: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
};

function matchesAny(buffer, signatures) {
  return signatures.some((sig) => sig.every((byte, i) => buffer[i] === byte));
}

function isImage(buffer) {
  if (matchesAny(buffer, SIGNATURES.webp)) {
    return buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return matchesAny(buffer, SIGNATURES.jpeg) || matchesAny(buffer, SIGNATURES.png) || matchesAny(buffer, SIGNATURES.gif);
}

function isOfficeZip(buffer) {
  return matchesAny(buffer, SIGNATURES.zip);
}

function isLegacyOle(buffer) {
  return matchesAny(buffer, SIGNATURES.ole2);
}

function isPdf(buffer) {
  return matchesAny(buffer, SIGNATURES.pdf);
}

// Plain-text formats (.csv/.txt) have no magic bytes of their own. Reject a
// file that's secretly one of the binary formats above wearing a text
// extension, AND -- since that list can't cover every binary format that
// exists (an EXE, an archive format we don't otherwise handle, ...) -- fall
// back to a content heuristic: real text has no NUL bytes and is almost
// entirely printable ASCII/whitespace or valid UTF-8 continuation bytes.
function looksLikeKnownBinary(buffer) {
  return isImage(buffer) || isOfficeZip(buffer) || isLegacyOle(buffer) || isPdf(buffer);
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0x00) return false; // NUL never appears in real text
    const printableAscii = byte >= 0x20 && byte <= 0x7e;
    const commonWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const utf8Continuation = byte >= 0x80; // multi-byte UTF-8 (accented/Turkish text)
    if (!printableAscii && !commonWhitespace && !utf8Continuation) suspicious++;
  }
  return suspicious / sample.length < 0.01;
}

/**
 * @param {Buffer} buffer
 * @param {string} declaredKind - 'image' | 'pdf' | 'office' (docx/xlsx) |
 *        'legacyOffice' (xls) | 'text' (csv/txt)
 * @returns {boolean}
 */
export function matchesDeclaredFileType(buffer, declaredKind) {
  if (!buffer || buffer.length < 4) return false;
  switch (declaredKind) {
    case 'image': return isImage(buffer);
    case 'pdf': return isPdf(buffer);
    case 'office': return isOfficeZip(buffer);
    case 'legacyOffice': return isOfficeZip(buffer) || isLegacyOle(buffer);
    case 'text': return !looksLikeKnownBinary(buffer) && looksLikeText(buffer);
    default: return false;
  }
}
