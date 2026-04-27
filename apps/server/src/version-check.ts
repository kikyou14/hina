const GITHUB_REPO = "kikyou14/hina";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const SERVER_TAG_RE = /^\d+\.\d+\.\d+$/;

type LatestRelease = {
  version: string;
  url: string;
};

let cached: LatestRelease | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function check() {
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50&page=${page}`,
        { headers: { Accept: "application/vnd.github.v3+json" } },
      );
      if (!res.ok) return;
      const releases = (await res.json()) as Array<{
        tag_name: string;
        html_url: string;
        draft: boolean;
        prerelease: boolean;
      }>;
      if (releases.length === 0) break;
      const latest = releases.find(
        (r) => !r.draft && !r.prerelease && SERVER_TAG_RE.test(r.tag_name),
      );
      if (latest) {
        cached = { version: latest.tag_name, url: latest.html_url };
        return;
      }
      if (releases.length < 50) break;
    }
  } catch {
    // keep last known good value
  }
}

export function getLatestRelease(): LatestRelease | null {
  return cached;
}

export function startVersionCheck() {
  if (timer) return;
  void check();
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS);
}

export function stopVersionCheck() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  cached = null;
}
