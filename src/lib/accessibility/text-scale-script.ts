/**
 * The pre-paint script that sets `data-font-scale` before first paint.
 *
 * Rendered inline in `<head>` because a `useEffect`-based application would
 * flash the default size and then jump — precisely the jarring, "something is
 * broken" feeling this feature exists to remove. It is a string rather than a
 * component because it must run *before* hydration, and it may not import the
 * module above (that would pull `text-scale.ts` through the client bundle for
 * two constants). Keep the two in sync; `text-scale.test.ts` asserts the
 * accepted values match the exported options.
 */
export const TEXT_SCALE_PREPAINT_SCRIPT = `(function(){try{var v=localStorage.getItem('eccb:text-scale');if(v!=='small'&&v!=='medium'&&v!=='large'&&v!=='xlarge'){v='medium';}document.documentElement.setAttribute('data-font-scale',v);}catch(e){document.documentElement.setAttribute('data-font-scale','medium');}})();`;