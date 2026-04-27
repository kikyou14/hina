import fs from "node:fs";
import path from "node:path";
import { open, type AsnResponse, type Reader } from "maxmind";

const ASN_MMDB_URL =
  "https://github.com/P3TERX/GeoLite.mmdb/releases/latest/download/GeoLite2-ASN.mmdb";
const ASN_MMDB_FILENAME = "GeoLite2-ASN.mmdb";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type AsnInfo = {
  asn: number;
  name: string;
};

export type AsnLookup = {
  lookup(ip: string): AsnInfo | null;
};

export type AsnDbStatus = {
  loaded: boolean;
  fileAgeMs: number | null;
  refreshing: boolean;
};

export type AsnLookupService = AsnLookup & {
  status(): AsnDbStatus;
  refresh(): Promise<{ ok: boolean; error?: string }>;
};

export function createAsnLookupService(dataDir: string): AsnLookupService {
  const mmdbPath = path.join(dataDir, ASN_MMDB_FILENAME);
  let reader: Reader<AsnResponse> | null = null;
  let refreshing = false;

  function lookup(ip: string): AsnInfo | null {
    if (!reader) return null;
    const result = reader.get(ip);
    if (!result || !result.autonomous_system_number) return null;
    return {
      asn: result.autonomous_system_number,
      name: result.autonomous_system_organization ?? "",
    };
  }

  function fileAgeMs(): number | null {
    try {
      return Date.now() - fs.statSync(mmdbPath).mtimeMs;
    } catch {
      return null;
    }
  }

  function status(): AsnDbStatus {
    return {
      loaded: reader !== null,
      fileAgeMs: fileAgeMs(),
      refreshing,
    };
  }

  async function tryLoad(): Promise<boolean> {
    try {
      reader = await open(mmdbPath);
      return true;
    } catch {
      reader = null;
      return false;
    }
  }

  async function refresh(): Promise<{ ok: boolean; error?: string }> {
    if (refreshing) return { ok: false, error: "already refreshing" };
    refreshing = true;
    try {
      await downloadMmdb(mmdbPath);
      const loaded = await tryLoad();
      if (!loaded) {
        // Remove corrupt file so the next startup retries the download
        try {
          fs.unlinkSync(mmdbPath);
        } catch {}
        throw new Error("downloaded file is not a valid MMDB database");
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      refreshing = false;
    }
  }

  // Boot: load existing file if fresh, otherwise download in background.
  // Never blocks startup.
  const age = fileAgeMs();
  const needsDownload = age === null || age >= REFRESH_INTERVAL_MS;

  if (needsDownload) {
    // Download + load in one step; avoids race between tryLoad(old) and refresh()
    void refresh().then((result) => {
      if (result.ok) {
        console.log("ASN database downloaded and loaded");
      } else {
        console.warn(`ASN database download failed: ${result.error}`);
        // If a stale file exists but refresh failed, try loading it as fallback
        if (age !== null) {
          void tryLoad().then((ok) => {
            if (ok) console.log(`ASN database loaded (stale) from ${mmdbPath}`);
          });
        }
      }
    });
  } else {
    // File is fresh — just load it
    void tryLoad().then((ok) => {
      if (ok) console.log(`ASN database loaded from ${mmdbPath}`);
    });
  }

  return { lookup, status, refresh };
}

async function downloadMmdb(destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const resp = await fetch(ASN_MMDB_URL, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.arrayBuffer();
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${destPath}.tmp`;
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, destPath);
  } finally {
    clearTimeout(timer);
  }
}
