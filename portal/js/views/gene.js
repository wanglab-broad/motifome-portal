/* =============================================================================
   views/gene.js — route module for #/gene/:refseq

   The shell's registry (js/main.js) imports './views/gene.js'. The view itself
   lives one level up in js/view-gene.js, next to its rendering engine
   js/seqview.js, so the two files that make up R1 sit together. This module is
   the adapter: it exports exactly the shape the shell's view API asks for.
   ============================================================================= */

export { render, teardown } from '../view-gene.js';

export function title(params) {
  return (params && params.refseq) ? String(params.refseq) : 'Gene';
}
