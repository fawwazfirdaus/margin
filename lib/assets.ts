import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function scriptAsset(path: string) {
  if(path==='/shared/post-links.js'||path==='/shared/free-thread.js')return {file:root+'dist'+path,type:'text/javascript'};
  if (/^\/(app|dom|ocr|reader|post-context|linked-post|index-links|free-thread)\.js$/.test(path))
    return { file: root + 'dist/client' + path, type: 'text/javascript' };
  if (/^\/ocr\/(tesseract|worker)\.min\.js$/.test(path))
    return { file: root + 'node_modules/tesseract.js/dist/' + path.split('/').pop(), type: 'text/javascript' };
  if (path === '/ocr/lang/eng.traineddata.gz')
    return {
      file: root + 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
      type: 'application/octet-stream'
    };
  if (/^\/ocr\/core\/tesseract-core(?:-relaxedsimd|-simd)?(?:-lstm)?\.wasm(?:\.js)?$/.test(path))
    return {
      file: root + 'node_modules/tesseract.js-core/' + path.split('/').pop(),
      type: path.endsWith('.js') ? 'text/javascript' : 'application/wasm'
    };
}
