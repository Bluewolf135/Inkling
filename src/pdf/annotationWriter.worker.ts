import type { PDFDocument } from 'pdf-lib';
import { openDocument, writeDocument } from './annotationWriterCore';
import type { WorkerRequestMessage, WorkerResponseMessage } from './annotationWriterProtocol';

// Runs pdf-lib's parse/mutate/save entirely off the main thread. pdf-lib's
// save() is a full-document re-serialize with no true incremental mode —
// for a densely annotated PDF that's real, sustained CPU work (seconds, on
// a page thick with strokes), and running it on the main thread stalled
// pointer input for that whole stretch, felt directly as "the pen won't
// write." One worker instance == one open file's PDFDocument for the life
// of an Inkling editing session (PdfAnnotateView terminates it and spawns a
// fresh one for the next file, rather than juggling several documents in
// here) — so `doc` staying alive across multiple 'write' messages also
// avoids re-parsing the whole file from scratch on every autosave.
//
// The actual work lives in annotationWriterCore.ts, shared with the main-
// thread fallback in annotationWriterClient.ts — see there for why a
// fallback is needed at all.
let doc: PDFDocument | null = null;

function reply(message: WorkerResponseMessage, transfer: Transferable[] = []): void {
	(self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
	const message = event.data;

	if (message.type === 'open') {
		try {
			const opened = await openDocument(message.bytes);
			doc = opened.doc;

			const transfer: Transferable[] = [opened.displayBytes];
			if (opened.prunedBytes) transfer.push(opened.prunedBytes);

			reply(
				{
					type: 'opened',
					requestId: message.requestId,
					ok: true,
					savedAnnotations: opened.savedAnnotations,
					displayBytes: opened.displayBytes,
					prunedBytes: opened.prunedBytes,
				},
				transfer,
			);
		} catch (error) {
			reply({ type: 'opened', requestId: message.requestId, ok: false, error: String(error) });
		}
		return;
	}

	if (!doc) {
		reply({ type: 'written', requestId: message.requestId, ok: false, error: 'Inkling: no document open in the annotation writer.' });
		return;
	}

	try {
		const buffer = await writeDocument(doc, message.pages);
		reply({ type: 'written', requestId: message.requestId, ok: true, bytes: buffer }, [buffer]);
	} catch (error) {
		reply({ type: 'written', requestId: message.requestId, ok: false, error: String(error) });
	}
};

// Sent unprompted, as the last thing this script does: the client waits a
// short while for exactly this before trusting the worker with any real
// work, and falls back to running everything on the main thread if it never
// arrives. Desktop Obsidian turned out to need that — a worker there can be
// constructed without error and then never run its script at all, so
// "constructed successfully" is not on its own evidence of a live worker.
reply({ type: 'ready' });
