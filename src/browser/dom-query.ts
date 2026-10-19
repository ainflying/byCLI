/** Query the document and accessible open shadow roots, never iframe documents. */
export const DEEP_QUERY_JS = `
function deepQueryAll(selector) {
  const result = [];
  function visit(root) {
    for (const node of root.querySelectorAll(selector)) result.push(node);
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) visit(host.shadowRoot);
    }
  }
  visit(document);
  return result;
}
`;
