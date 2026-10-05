/**
 * Destination classification.
 *
 * Recognizes what KIND of terminal destination a URL is: Telegram, Discord,
 * a direct download, a known file/cloud host, or a normal website. A normal
 * website can be final — but only when its flow actually terminates there
 * (decided by the resolution engine, not here).
 */

import type { DestinationType } from "@contracts/unwrap";

const TELEGRAM_HOSTS = /(^|\.)(t\.me|telegram\.me|telegram\.dog)$/i;
const DISCORD_HOSTS = /(^|\.)discord\.gg$/i;
const DISCORD_INVITE = /(^|\.)(discord\.com|discordapp\.com)$/i;

/** Well-known file / cloud storage destinations. */
const FILE_HOSTS =
  /(^|\.)(drive\.google\.com|docs\.google\.com|mega\.nz|mega\.co\.nz|mediafire\.com|dropbox\.com|terabox\.com|1fichier\.com|gofile\.io|pixeldrain\.com|zippyshare\.com|anonfiles\.com|krakenfiles\.com|sendspace\.com|wetransfer\.com|filemail\.com|uploadhaven\.com|userscloud\.com|rapidgator\.net|nitroflare\.com|katfile\.com|ddownload\.com|filecrypt\.cc|workupload\.com|box\.com|onedrive\.live\.com|1drv\.ms)$/i;

/**
 * Classify a destination URL. Returns null for ordinary websites — the
 * engine decides separately whether such a page is actually terminal.
 */
export function classifyDestinationUrl(rawUrl: string): DestinationType | null {
  if (/^tg:\/\//i.test(rawUrl)) return "telegram";
  if (/^discord:\/\//i.test(rawUrl)) return "discord";

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;

  if (TELEGRAM_HOSTS.test(host)) return "telegram";
  if (DISCORD_HOSTS.test(host)) return "discord";
  if (DISCORD_INVITE.test(host) && /^\/(invite|channels)\//i.test(url.pathname)) {
    return "discord";
  }
  if (FILE_HOSTS.test(host)) return "file_host";
  return null;
}

/**
 * True when a document response is a file download rather than a page:
 * Content-Disposition attachment, or a clearly non-document content type.
 */
export function isDownloadResponse(
  contentType: string | null | undefined,
  contentDisposition: string | null | undefined,
): boolean {
  if (contentDisposition && /attachment/i.test(contentDisposition)) return true;
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  if (/text\/html|application\/xhtml|text\/plain|application\/json/.test(ct)) return false;
  return /application\/(octet-stream|zip|x-zip|pdf|x-7z|x-rar|x-tar|gzip|vnd\.|msdownload|x-msdos|x-apk|x-iso)/i.test(
    ct,
  );
}
