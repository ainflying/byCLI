import { ArgumentError } from '@sovovs/bycli/errors';
import { sanitizeFilename } from '@sovovs/bycli/download';

export function safeMetadata(work) {
    // Explicit fields keep raw API state, request headers and browser secrets out of files.
    const author = work.author || {};
    const statistics = Object.fromEntries(Object.entries(work.statistics || {})
        .filter(([key, value]) => /^(digg|comment|collect|share|play|download)_count$/.test(key)
            && (value === null || typeof value === 'number')));
    const url = /^\d+$/.test(String(work.aweme_id)) ? `https://www.douyin.com/${work.media_type === 'image' ? 'note' : 'video'}/${work.aweme_id}` : undefined;
    return {
        aweme_id: String(work.aweme_id), url, title: work.title ?? '', media_type: work.media_type,
        author: { uid: author.uid, sec_uid: author.sec_uid, nickname: author.nickname },
        create_time: work.create_time ?? null, duration: work.duration ?? null, statistics,
        image_count: Array.isArray(work.images) ? work.images.length : 0,
    };
}

// These are internal download inputs, separate from the command's result rows.
export function planDownloadArtifacts(work, options) {
    const id = String(work.aweme_id ?? '');
    const stem = sanitizeFilename(id);
    if (!stem) throw new ArgumentError('The resolved Douyin work ID has no valid filename characters');
    const images = Array.isArray(work.images) ? work.images : [];
    const media = work.media_type === 'image' || (images.length && !work.play_url)
        ? images.map((image, index) => ({ type: 'image', url: typeof image === 'string' ? image : image.url || image.urls?.[0], filename: `${stem}_${index + 1}.jpg` }))
        : [{ type: 'video', url: work.play_url || work.play_urls?.[0], filename: `${stem}.mp4` }];
    const artifacts = [...media.map(item => ({ ...item, artifactType: item.type }))];
    if (options.cover) artifacts.push({ type: 'image', artifactType: 'cover', url: work.cover_url, filename: `${stem}_cover.jpg` });
    return { id, stem, media, artifacts };
}
