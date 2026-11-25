import type { VideoAttachment } from '../shared/contracts.js';

type Sources = Pick<VideoAttachment, 'src' | 'variants'>;
type Connection = { saveData?: boolean; downlink?: number; effectiveType?: string };

function connection(): Connection {
  return (navigator as Navigator & { connection?: Connection }).connection || {};
}

function conserveData(net: Connection) {
  return net.saveData || net.effectiveType === 'slow-2g' || net.effectiveType === '2g';
}

// X supplies MP4 variants in descending bitrate order. Leave headroom for
// fluctuating throughput and cap the default quality for the inline reader.
function inlineSource(media: Sources, net: Connection) {
  if (!media.variants?.length) return media.src;
  const downlink = net.downlink ?? (net.effectiveType === '3g' ? 1 : 10);
  const budget = conserveData(net) ? 0 : Math.min(2_560_000, downlink * 650_000);
  return (media.variants.find(v => v.bitrate <= budget) || media.variants.at(-1))?.src || media.src;
}

export function releaseVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  video.pause();
  video.replaceChildren();
  video.removeAttribute('src');
  video.load(); // Abort outstanding range requests, including on detached elements.
}

export function videoLoader() {
  let staged: { src: string; original?: string; player: HTMLVideoElement } | undefined;
  let candidate: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;

  function endIntent() {
    clearTimeout(timer);
    candidate = undefined;
  }
  function clear() {
    endIntent();
    if (staged) releaseVideo(staged.player);
    staged = undefined;
  }
  function stage(media: Sources | undefined, preload: HTMLVideoElement['preload']) {
    const src = media && inlineSource(media, connection());
    if (!src || !media) { clear(); return; }
    if (staged?.src !== src || staged.original !== media.src || staged.player.error) {
      if (staged) releaseVideo(staged.player);
      const player = document.createElement('video');
      player.preload = preload;
      player.playsInline = true;
      if (media.src && media.src !== src) {
        for (const url of [src, media.src]) {
          const source = document.createElement('source');
          source.src = url;
          source.type = 'video/mp4';
          player.append(source);
        }
      } else {
        player.src = src;
      }
      staged = { src, original: media.src, player };
    } else {
      staged.player.preload = preload;
    }
  }

  function cancelIntent() {
    if (candidate) clear();
  }
  function bind(button: HTMLElement, media: Sources) {
    if (!connected && media.src?.startsWith('https://video.twimg.com/') && !conserveData(connection())) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = 'https://video.twimg.com';
      document.head.append(link);
      connected = true;
    }
    function hint() {
      if (document.hidden || document.querySelector('dialog[open]') || conserveData(connection())) return;
      cancelIntent();
      candidate = button;
      timer = setTimeout(() => stage(media, 'metadata'), 180);
    }
    function leave() {
      if (candidate === button) clear();
    }
    button.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') hint(); });
    button.addEventListener('pointerdown', e => {
      if (!e.isPrimary || e.button !== 0 || conserveData(connection())) return;
      endIntent();
      candidate = button;
      stage(media, 'metadata');
    });
    button.addEventListener('pointercancel', leave);
    // Touch releases implicit capture before click, firing pointerleave even on a tap.
    button.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') leave(); });
    button.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse' && candidate === button) timer = setTimeout(leave, 500);
    });
    button.addEventListener('contextmenu', leave);
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) hint(); });
    button.addEventListener('blur', leave);
  }

  function opening(media?: Sources) {
    endIntent();
    stage(media, conserveData(connection()) ? 'none' : 'auto');
  }
  function take(media: VideoAttachment) {
    opening(media); // Reconcile the search result with the current reader data.
    const video = staged!.player;
    staged = undefined;
    video.controls = true;
    if (media.poster) video.poster = media.poster;
    if (media.type === 'animated_gif') video.loop = video.muted = true;
    return video;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelIntent(); });
  return { bind, opening, take, clear, cancelIntent };
}
