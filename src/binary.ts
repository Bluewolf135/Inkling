// vault.createBinary/modifyBinary want an ArrayBuffer; pdf-lib hands back a
// Uint8Array that may be a view over a larger underlying buffer, so a plain
// `.buffer` reference can carry unrelated bytes with it — always slice to
// the view's own bounds.
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
