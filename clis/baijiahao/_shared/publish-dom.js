// Normal editor DOM only. No framework instances, hidden state or HTTP writes.
export function publisherDOM(kind, action, op, bodyValue = '') {
  const clean = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[\u200b\ufeff]/g, '').trim();
  const visible = node => {
    for (let n = node; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (n.hidden || n.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  if (location.origin !== 'https://baijiahao.baidu.com' || location.pathname !== '/builder/rc/edit') return { error: 'wrong_editor' };
  const video = kind === 'video', url = new URL(location.href);
  if (url.searchParams.get('type') !== (video ? 'videoV2' : 'news')) return { error: 'wrong_type' };
  const id = url.searchParams.get('article_id');
  if (op.id && op.id !== id) return { error: 'wrong_draft' };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const verification = [...document.querySelectorAll('[class*="passMod_dialog"]')].some(visible)
    || dialogs.some(n => /安全验证|验证码/.test(n.textContent));
  // The initial video upload screen has no form until a file is selected.
  const form = document.querySelector('form') || (video ? document.querySelector('#root') : null);
  if (!form) return { error: 'editor_loading' };
  const mark = (nodes, key) => {
    if (nodes.length !== 1) return null;
    // The sticky footer can cover an otherwise in-viewport field. Center it
    // before native input, rather than trusting a click behind that footer.
    if (nodes[0].type !== 'file') nodes[0].scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const value = `${op.operationId}:${key}`;
    for (const node of document.querySelectorAll('[data-bycli-baijiahao-action]')) if (node.getAttribute('data-bycli-baijiahao-action') === value) node.removeAttribute('data-bycli-baijiahao-action');
    nodes[0].setAttribute('data-bycli-baijiahao-action', value);
    return `[data-bycli-baijiahao-action="${value}"]`;
  };
  const titles = [...form.querySelectorAll(video ? '[contenteditable="true"][role="textbox"]' : '[data-testid="news-title-input"] [contenteditable="true"]')].filter(visible);
  const title = titles.length === 1 ? clean(titles[0].innerText || titles[0].textContent) : null;
  const bodyDoc = !video ? document.querySelector('#ueditor_0')?.contentDocument : null;
  const body = bodyDoc?.body;
  const bodyClone = body?.cloneNode(true);
  bodyClone?.querySelectorAll('.bjh-clear-at-out-put').forEach(n => n.remove());
  bodyClone?.querySelectorAll('.bjh-image-caption.ue_t').forEach(n => { if (clean(n.textContent) === n.getAttribute('data-bjh-caption-text')) n.remove(); });
  bodyClone?.querySelectorAll('p').forEach(n => {
    if (/^[\s\u200b-\u200d\ufeff]*$/.test(n.textContent) && [...n.children].every(child => child.tagName === 'BR')) n.remove();
  });
  const bodyText = bodyClone ? clean(bodyClone.textContent) : null;
  const imageKey = node => {
    const value = node.getAttribute('data-bjh-origin-src') || node.src;
    try { const parsed = new URL(value); parsed.protocol = 'https:'; return parsed.href; } catch { return ''; }
  };
  const images = body ? [...body.querySelectorAll('img')].filter(n => !n.closest('.bjh-clear-at-out-put')) : [];
  const coverSection = form.querySelector('label[for="cover"]')?.closest('.cheetah-form-item');
  const coverImages = [...(video ? form.querySelectorAll('[data-testid="cover-preview"] img') : coverSection?.querySelectorAll('img') || [])];
  const videos = [...document.querySelectorAll('#root video')].filter(n => n.currentSrc || n.src);
  const mediaReady = !video || videos.length > 0 && videos.some(n => Number.isFinite(n.duration) && n.duration > 0);
  const files = [...document.querySelectorAll('input[type="file"]')];
  const outsideModal = files.filter(n => !n.closest('[role="dialog"]'));
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  const enabled = n => !n.disabled && n.getAttribute('aria-disabled') !== 'true';
  const checkbox = label => [...form.querySelectorAll('label')].filter(n => clean(n.textContent) === label).flatMap(n => [...n.querySelectorAll('input[type="checkbox"]')]);
  const aiBoxes = checkbox('采用AI生成内容'), podcastBoxes = checkbox('自动生成播客');
  const aiInputs = [...form.querySelectorAll('input[placeholder="请选择创作声明"]')];
  const aiLabel = aiInputs.length === 1 ? aiInputs[0].value : null;
  const aiSelected = video ? aiLabel === (op.aiGenerated === 'yes' ? '含AI生成内容' : '无需声明') : aiBoxes.length === 1 && aiBoxes[0].checked === (op.aiGenerated === 'yes');
  let selector = null;
  if (action === 'bind') document.documentElement.setAttribute('data-bycli-baijiahao-operation', op.operationId);
  if (!verification) {
    if (action === 'title') selector = mark(titles, action);
    if (action === 'video') selector = mark(outsideModal.filter(n => /\.mp4/.test(n.accept)), action);
    if (action === 'image-dialog') selector = mark([...form.querySelectorAll('.edui-for-insertimage .edui-button-body')], action);
    if (action === 'images') selector = mark(dialogs.filter(n => /本地图片/.test(n.textContent)).flatMap(n => [...n.querySelectorAll('input[type="file"][accept="image/*"][multiple]')]), action);
    if (action === 'confirm') selector = mark(dialogs.flatMap(n => [...n.querySelectorAll('button')].filter(b => visible(b) && enabled(b) && /^(确定|确认)(\s*\(\d+\))?$/.test(clean(b.textContent)))), action);
    if (action === 'cover' || action === 'vertical-cover') {
      const inputs = outsideModal.filter(n => n.name === 'media' && n.accept === 'image/*' && !n.multiple);
      if (video && inputs.length === 2) selector = mark([inputs[action === 'cover' ? 0 : 1]], action);
      if (!video) selector = mark([...form.querySelectorAll('div')].filter(n => visible(n) && n.children.length === 0 && clean(n.textContent) === '选择封面'), action);
    }
    if (action === 'cover-file') selector = mark(dialogs.flatMap(n => [...n.querySelectorAll('input[name="media"][type="file"][accept="image/*"]')]).filter(n => !n.multiple && /本地上传/.test(n.parentElement.textContent)), action);
    if (action === 'podcast') selector = mark(podcastBoxes, action);
    if (action === 'ai') {
      if (!video) selector = mark(aiBoxes, action);
      else {
        const expected = op.aiGenerated === 'yes' ? '含AI生成内容' : '无需声明';
        const modal = dialogs.filter(n => /必选声明/.test(n.textContent));
        const choices = modal.flatMap(n => [...n.querySelectorAll('span')].filter(n => n.children.length === 0 && clean(n.textContent) === expected));
        if (choices.length === 1 && choices[0].parentElement.querySelector('input[type="radio"]')?.checked) {
          selector = mark([...modal[0].querySelectorAll('button')].filter(n => enabled(n) && clean(n.textContent) === '确定'), action);
        } else selector = mark(modal.length ? choices : aiInputs, action);
      }
    }
    if (action === 'save') selector = mark(buttons.filter(n => clean(n.textContent) === '存草稿' && enabled(n)), action);
    if (action === 'submit' && !dialogs.length && mediaReady && aiSelected) selector = mark(buttons.filter(n => n.matches('[data-testid="publish-btn"]') && enabled(n)), action);
    if (action === 'body') {
      if (!body || body.getAttribute('contenteditable') !== 'true' || document.documentElement.getAttribute('data-bycli-baijiahao-operation') !== op.operationId) return { error: 'body_unavailable' };
      body.focus(); const selection = bodyDoc.getSelection(), range = bodyDoc.createRange();
      range.selectNodeContents(body); selection.removeAllRanges(); selection.addRange(range);
      if (!bodyDoc.execCommand('insertText', false, bodyValue)) return { error: 'body_input_failed' };
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: bodyValue }));
      // UEditor represents newlines as block boundaries rather than text nodes.
      return { bodyWritten: clean(body.textContent).replace(/\s+/g, '') === clean(bodyValue).replace(/\s+/g, '') };
    }
  }
  return { url: location.href, id, operationId: document.documentElement.getAttribute('data-bycli-baijiahao-operation'), verification,
    title, body: bodyText, imageKeys: images.map(imageKey), imagesReady: images.every(n => n.complete && n.naturalWidth > 0),
    coverKeys: coverImages.map(imageKey), coversReady: coverImages.length >= (video ? 2 : 1) && coverImages.every(n => n.complete && n.naturalWidth > 0),
    mediaReady, aiSelected: !!aiSelected, aiLabel, podcastDisabled: podcastBoxes.length === 1 && !podcastBoxes[0].checked,
    dialogText: dialogs.map(n => clean(n.textContent)).join('\n').slice(0,1500), selector };
}
export const publisherScript = (kind, action, op, body = '') => `(${publisherDOM.toString()})(${[kind, action, { operationId: op.operationId, id: op.id, aiGenerated: op.aiGenerated }, body].map(v => JSON.stringify(v)).join(',')})`;
