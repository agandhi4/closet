export interface MultipartFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Serialises a multipart/form-data body through the platform FormData so
 * the boundary and part headers are exactly what a browser would send.
 * Spread the result into inject(): `inject({ method: 'POST', url, ...body })`.
 */
export async function multipart(
  fields: Record<string, string>,
  files: Record<string, MultipartFile | readonly MultipartFile[]> = {},
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  // A list is several parts under one name, as a `multiple` input sends.
  for (const [name, entry] of Object.entries(files)) {
    for (const file of 'data' in entry ? [entry] : entry) {
      form.append(
        name,
        // A Uint8Array view: Node's Buffer<ArrayBufferLike> is not a BlobPart
        // in the DOM lib's types (it may sit on a SharedArrayBuffer).
        new Blob([new Uint8Array(file.data)], { type: file.contentType }),
        file.filename,
      );
    }
  }
  const encoded = new Response(form);
  return {
    payload: Buffer.from(await encoded.arrayBuffer()),
    headers: { 'content-type': encoded.headers.get('content-type')! },
  };
}
