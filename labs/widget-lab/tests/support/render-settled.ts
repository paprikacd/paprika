import type { ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { Writable } from 'node:stream';

/**
 * Renders markup after every lazily loaded renderer has resolved. Production registers plugin renderers with
 * React.lazy, and renderToStaticMarkup cannot wait for a suspended component.
 */
export function renderSettled(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const sink = new Writable({
      write(chunk, _encoding, callback) { html += chunk.toString(); callback(); },
    });
    const { pipe } = renderToPipeableStream(element, {
      onAllReady() { pipe(sink); },
      onError(error) { reject(error); },
    });
    sink.on('finish', () => resolve(html));
    sink.on('error', reject);
  });
}
