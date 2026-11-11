import { Drop } from '../Drop';

/** The brand in the docs header: the drop mark and the name. The layout wraps it in a link to the home page. */
export function DocsBrand() {
  return (
    <>
      <Drop width={10} className="docs-brand-mark" />
      <span className="docs-brand-name">THULI</span>
    </>
  );
}
