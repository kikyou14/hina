use std::collections::HashSet;
use std::ffi::OsString;
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use std::{
    fs,
    io::{BufRead, BufReader},
    path::Path,
};

use serde_json::{Map, Value};
use sysinfo::{Components, Disks, Networks, System};

#[derive(Debug, Clone)]
pub struct InventorySnapshot {
    pub value: Value,
}

#[derive(Debug, Clone)]
pub struct TelemetrySnapshot {
    pub uptime_seconds: Option<u64>,
    pub rx_bytes_total: u64,
    pub tx_bytes_total: u64,
    pub metrics: Map<String, Value>,
}

pub struct TelemetryCollector {
    system: System,
    networks: Networks,
    disks: Disks,
    components: Components,
    allowed_mount_points: Option<Vec<PathBuf>>,
    prev_net_rx: Option<u64>,
    prev_net_tx: Option<u64>,
    prev_net_ts: Option<std::time::Instant>,
}

impl TelemetryCollector {
    pub fn new(allowed_mount_points: Option<Vec<PathBuf>>) -> Self {
        let system = System::new_all();
        let networks = Networks::new_with_refreshed_list();
        let disks = Disks::new_with_refreshed_list();
        let components = Components::new_with_refreshed_list();

        Self {
            system,
            networks,
            disks,
            components,
            allowed_mount_points,
            prev_net_rx: None,
            prev_net_tx: None,
            prev_net_ts: None,
        }
    }

    pub fn collect_inventory(&mut self) -> InventorySnapshot {
        self.system.refresh_all();

        self.disks.refresh(false);
        self.networks.refresh(false);
        self.components.refresh(false);

        let cpu_brand = self.system.cpus().first().map(|c| c.brand().to_string());
        let cpu_vendor = self
            .system
            .cpus()
            .first()
            .map(|c| c.vendor_id().to_string());
        let cpu_count = self.system.cpus().len() as u64;

        let kernel_version = System::kernel_version();
        let virtualization = collect_virtualization_type();

        let mem_total_bytes = self.system.total_memory();
        let swap_total_bytes = self.system.total_swap();

        let (disk_total, disk_available) =
            filter_and_sum_disks(&self.disks, self.allowed_mount_points.as_deref());
        let (rx_total, tx_total) = sum_network_totals(&self.networks);
        let gpus = collect_gpu_inventory();

        let mut root = Map::new();
        root.insert("cpu_brand".to_string(), opt_string(cpu_brand));
        root.insert("cpu_vendor".to_string(), opt_string(cpu_vendor));
        root.insert("cpu_count".to_string(), Value::from(cpu_count));

        root.insert("kernel_version".to_string(), opt_string(kernel_version));
        root.insert("virtualization".to_string(), opt_string(virtualization));

        root.insert("mem_total_bytes".to_string(), Value::from(mem_total_bytes));
        root.insert(
            "swap_total_bytes".to_string(),
            Value::from(swap_total_bytes),
        );

        root.insert("disk_total_bytes".to_string(), Value::from(disk_total));
        root.insert(
            "disk_available_bytes".to_string(),
            Value::from(disk_available),
        );

        root.insert("net_rx_total_bytes".to_string(), Value::from(rx_total));
        root.insert("net_tx_total_bytes".to_string(), Value::from(tx_total));
        root.insert(
            "gpus".to_string(),
            Value::Array(gpus.into_iter().map(gpu_inventory_to_value).collect()),
        );

        InventorySnapshot {
            value: Value::Object(root),
        }
    }

    pub fn collect_telemetry(&mut self) -> TelemetrySnapshot {
        self.system.refresh_all();

        self.disks.refresh(false);
        self.networks.refresh(false);
        self.components.refresh(false);

        let uptime_seconds = Some(System::uptime());
        let cpu_usage = self.system.global_cpu_usage() as f64;

        let mem_total_bytes = self.system.total_memory() as f64;
        let mem_used_bytes = self.system.used_memory() as f64;
        let swap_total_bytes = self.system.total_swap() as f64;
        let swap_used_bytes = self.system.used_swap() as f64;

        let mem_used_pct = if mem_total_bytes > 0.0 {
            mem_used_bytes / mem_total_bytes * 100.0
        } else {
            0.0
        };
        let swap_used_pct = if swap_total_bytes > 0.0 {
            swap_used_bytes / swap_total_bytes * 100.0
        } else {
            0.0
        };

        let (disk_total_bytes, disk_available_bytes) =
            filter_and_sum_disks(&self.disks, self.allowed_mount_points.as_deref());
        let disk_used_bytes = disk_total_bytes.saturating_sub(disk_available_bytes);
        let disk_used_pct = if disk_total_bytes > 0 {
            disk_used_bytes as f64 / disk_total_bytes as f64 * 100.0
        } else {
            0.0
        };

        let (rx_bytes_total, tx_bytes_total) = sum_network_totals(&self.networks);

        let now_ts = std::time::Instant::now();
        let net_rate = match (self.prev_net_rx, self.prev_net_tx, self.prev_net_ts) {
            (Some(prev_rx), Some(prev_tx), Some(prev_ts)) => {
                let elapsed = now_ts.duration_since(prev_ts).as_secs_f64();
                if elapsed >= 0.5 {
                    let delta_rx = rx_bytes_total.saturating_sub(prev_rx);
                    let delta_tx = tx_bytes_total.saturating_sub(prev_tx);
                    Some((delta_rx as f64 / elapsed, delta_tx as f64 / elapsed))
                } else {
                    None
                }
            }
            _ => None,
        };
        self.prev_net_rx = Some(rx_bytes_total);
        self.prev_net_tx = Some(tx_bytes_total);
        self.prev_net_ts = Some(now_ts);

        let load_avg = System::load_average();

        let mut m = Map::new();
        m.insert("cpu.usage_pct".to_string(), Value::from(cpu_usage));
        m.insert("mem.total_bytes".to_string(), Value::from(mem_total_bytes));
        m.insert("mem.used_bytes".to_string(), Value::from(mem_used_bytes));
        m.insert("mem.used_pct".to_string(), Value::from(mem_used_pct));
        m.insert(
            "swap.total_bytes".to_string(),
            Value::from(swap_total_bytes),
        );
        m.insert("swap.used_bytes".to_string(), Value::from(swap_used_bytes));
        m.insert("swap.used_pct".to_string(), Value::from(swap_used_pct));
        m.insert(
            "disk.total_bytes".to_string(),
            Value::from(disk_total_bytes),
        );
        m.insert("disk.used_bytes".to_string(), Value::from(disk_used_bytes));
        m.insert("disk.used_pct".to_string(), Value::from(disk_used_pct));
        m.insert("load.1".to_string(), Value::from(load_avg.one));
        m.insert("load.5".to_string(), Value::from(load_avg.five));
        m.insert("load.15".to_string(), Value::from(load_avg.fifteen));
        m.insert(
            "proc.count".to_string(),
            Value::from(self.system.processes().len() as u64),
        );

        if let Some((tcp, udp)) = collect_connection_counts() {
            m.insert("conn.tcp.count".to_string(), Value::from(tcp));
            m.insert("conn.udp.count".to_string(), Value::from(udp));
            m.insert(
                "conn.total.count".to_string(),
                Value::from(tcp.saturating_add(udp)),
            );
        }

        if let Some(temp_c) = max_temperature_c(&self.components) {
            m.insert("temp.max_c".to_string(), Value::from(temp_c));
        }

        if let Some((rx_rate, tx_rate)) = net_rate {
            m.insert("net.rx_rate".to_string(), Value::from(rx_rate));
            m.insert("net.tx_rate".to_string(), Value::from(tx_rate));
        }

        TelemetrySnapshot {
            uptime_seconds,
            rx_bytes_total,
            tx_bytes_total,
            metrics: m,
        }
    }
}

fn opt_string(value: Option<String>) -> Value {
    match value {
        Some(s) => Value::String(s),
        None => Value::Null,
    }
}

const EXCLUDED_FS_TYPES: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "sysfs",
    "proc",
    "devpts",
    "securityfs",
    "cgroup",
    "cgroup2",
    "pstore",
    "efivarfs",
    "bpf",
    "debugfs",
    "tracefs",
    "hugetlbfs",
    "mqueue",
    "configfs",
    "fusectl",
    "ramfs",
    "squashfs",
    "fuse.snapfuse",
    "nsfs",
    "autofs",
];

const EXCLUDED_MOUNT_PREFIXES: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/run/user",
    "/snap",
    "/var/lib/docker",
    "/tmp",
];

fn filter_and_sum_disks(disks: &Disks, allowed: Option<&[PathBuf]>) -> (u64, u64) {
    let mut total = 0u64;
    let mut available = 0u64;
    let mut seen_devices: HashSet<OsString> = HashSet::new();

    for disk in disks.list() {
        let fs_type = disk.file_system().to_string_lossy();
        if EXCLUDED_FS_TYPES
            .iter()
            .any(|&excluded| fs_type == excluded)
        {
            continue;
        }

        let mount_point = disk.mount_point();
        if EXCLUDED_MOUNT_PREFIXES
            .iter()
            .any(|prefix| mount_point.starts_with(prefix))
        {
            continue;
        }

        if let Some(allow_list) = allowed
            && !allow_list
                .iter()
                .any(|allowed_mp| mount_point == allowed_mp)
        {
            continue;
        }

        let device_name = disk.name().to_os_string();
        if !device_name.is_empty() && !seen_devices.insert(device_name) {
            continue;
        }

        total = total.saturating_add(disk.total_space());
        available = available.saturating_add(disk.available_space());
    }
    (total, available)
}

fn sum_network_totals(networks: &Networks) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (name, data) in networks.iter() {
        if is_loopback_interface(name) {
            continue;
        }
        rx = rx.saturating_add(data.total_received());
        tx = tx.saturating_add(data.total_transmitted());
    }
    (rx, tx)
}

fn is_loopback_interface(name: &str) -> bool {
    name == "lo" || name == "lo0"
}

fn max_temperature_c(components: &Components) -> Option<f64> {
    let mut max = None::<f64>;
    for c in components.iter() {
        let Some(t) = c.temperature() else {
            continue;
        };
        let t = t as f64;
        if !t.is_finite() || t <= -100.0 || t >= 300.0 {
            continue;
        }
        max = Some(max.map_or(t, |m| m.max(t)));
    }
    max
}

fn collect_virtualization_type() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        collect_linux_virtualization_type()
    }

    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn collect_linux_virtualization_type() -> Option<String> {
    let osrelease = read_trimmed_file(Path::new("/proc/sys/kernel/osrelease")).unwrap_or_default();
    if osrelease.to_ascii_lowercase().contains("microsoft") {
        return Some("wsl".to_string());
    }

    let cgroup = read_trimmed_file(Path::new("/proc/1/cgroup")).unwrap_or_default();
    let cgroup_lower = cgroup.to_ascii_lowercase();
    if cgroup_lower.contains("docker") {
        return Some("docker".to_string());
    }
    if cgroup_lower.contains("kubepods") || cgroup_lower.contains("containerd") {
        return Some("container".to_string());
    }
    if cgroup_lower.contains("lxc") {
        return Some("lxc".to_string());
    }

    let mut hints: Vec<String> = Vec::new();
    for path in [
        "/sys/class/dmi/id/sys_vendor",
        "/sys/class/dmi/id/product_name",
        "/sys/class/dmi/id/product_version",
        "/sys/class/dmi/id/board_vendor",
        "/sys/class/dmi/id/bios_vendor",
    ] {
        if let Some(value) = read_trimmed_file(Path::new(path)) {
            if !value.is_empty() {
                hints.push(value);
            }
        }
    }

    let combined = hints.join(" ").to_ascii_lowercase();
    if combined.is_empty() {
        return None;
    }

    if combined.contains("kvm") || combined.contains("qemu") {
        return Some("kvm".to_string());
    }
    if combined.contains("vmware") {
        return Some("vmware".to_string());
    }
    if combined.contains("virtualbox") {
        return Some("virtualbox".to_string());
    }
    if combined.contains("xen") {
        return Some("xen".to_string());
    }
    if combined.contains("microsoft") || combined.contains("hyper-v") {
        return Some("hyperv".to_string());
    }

    let cpuinfo = read_trimmed_file(Path::new("/proc/cpuinfo")).unwrap_or_default();
    if cpuinfo.to_ascii_lowercase().contains("hypervisor") {
        return Some("vm".to_string());
    }

    None
}

fn collect_connection_counts() -> Option<(u64, u64)> {
    #[cfg(target_os = "linux")]
    {
        collect_linux_connection_counts()
    }

    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn collect_linux_connection_counts() -> Option<(u64, u64)> {
    let tcp4 = count_proc_net_entries("/proc/net/tcp");
    let tcp6 = count_proc_net_entries("/proc/net/tcp6");
    let udp4 = count_proc_net_entries("/proc/net/udp");
    let udp6 = count_proc_net_entries("/proc/net/udp6");

    let any = tcp4.is_some() || tcp6.is_some() || udp4.is_some() || udp6.is_some();
    if !any {
        return None;
    }

    let tcp = tcp4.unwrap_or(0).saturating_add(tcp6.unwrap_or(0));
    let udp = udp4.unwrap_or(0).saturating_add(udp6.unwrap_or(0));
    Some((tcp, udp))
}

#[cfg(target_os = "linux")]
fn count_proc_net_entries(path: &str) -> Option<u64> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);

    let mut header = String::new();
    if reader.read_line(&mut header).ok()? == 0 {
        return Some(0);
    }

    let mut count: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = match reader.read_line(&mut line) {
            Ok(n) => n,
            Err(_) => break,
        };
        if bytes == 0 {
            break;
        }
        if !line.trim().is_empty() {
            count = count.saturating_add(1);
        }
    }

    Some(count)
}

#[derive(Debug, Clone)]
struct GpuInventory {
    name: Option<String>,
    vendor: Option<String>,
    vendor_id: Option<String>,
    device_id: Option<String>,
    driver: Option<String>,
}

fn gpu_inventory_to_value(gpu: GpuInventory) -> Value {
    let mut root = Map::new();
    root.insert("name".to_string(), opt_string(gpu.name));
    root.insert("vendor".to_string(), opt_string(gpu.vendor));
    root.insert("vendor_id".to_string(), opt_string(gpu.vendor_id));
    root.insert("device_id".to_string(), opt_string(gpu.device_id));
    root.insert("driver".to_string(), opt_string(gpu.driver));
    Value::Object(root)
}

fn collect_gpu_inventory() -> Vec<GpuInventory> {
    #[cfg(target_os = "linux")]
    {
        collect_linux_gpu_inventory()
    }

    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn collect_linux_gpu_inventory() -> Vec<GpuInventory> {
    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if !is_primary_drm_card(name) {
            continue;
        }

        let device_dir = entry.path().join("device");
        if !device_dir.exists() {
            continue;
        }

        let vendor_id = read_trimmed_file(&device_dir.join("vendor")).map(normalize_pci_hex_id);
        let device_id = read_trimmed_file(&device_dir.join("device")).map(normalize_pci_hex_id);
        let vendor = vendor_id
            .as_deref()
            .and_then(map_pci_vendor_name)
            .map(str::to_string);
        let driver = read_symlink_basename(device_dir.join("driver"));
        let name = read_first_existing(&[
            device_dir.join("product_name"),
            device_dir.join("product"),
            device_dir.join("model"),
            device_dir.join("device_name"),
        ])
        .or_else(|| format_gpu_fallback_name(vendor.as_deref(), device_id.as_deref()));

        if name.is_none()
            && vendor.is_none()
            && vendor_id.is_none()
            && device_id.is_none()
            && driver.is_none()
        {
            continue;
        }

        out.push(GpuInventory {
            name,
            vendor,
            vendor_id,
            device_id,
            driver,
        });
    }

    out.sort_by(|a, b| {
        let left = a.name.as_deref().unwrap_or_default();
        let right = b.name.as_deref().unwrap_or_default();
        left.cmp(right)
    });
    out
}

#[cfg(target_os = "linux")]
fn is_primary_drm_card(name: &str) -> bool {
    if !name.starts_with("card") {
        return false;
    }
    name["card".len()..].chars().all(|c| c.is_ascii_digit())
}

#[cfg(target_os = "linux")]
fn read_trimmed_file(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(target_os = "linux")]
fn read_first_existing(paths: &[PathBuf]) -> Option<String> {
    for path in paths {
        if let Some(value) = read_trimmed_file(path) {
            return Some(value);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_symlink_basename(path: impl AsRef<Path>) -> Option<String> {
    let target = fs::read_link(path).ok()?;
    let name = target.file_name()?.to_str()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(target_os = "linux")]
fn normalize_pci_hex_id(value: String) -> String {
    let trimmed = value.trim();
    let without_prefix = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    format!("0x{}", without_prefix.to_ascii_lowercase())
}

#[cfg(target_os = "linux")]
fn map_pci_vendor_name(vendor_id: &str) -> Option<&'static str> {
    match vendor_id {
        "0x10de" => Some("NVIDIA"),
        "0x1002" | "0x1022" => Some("AMD"),
        "0x8086" => Some("Intel"),
        "0x1a03" => Some("ASPEED"),
        "0x15ad" => Some("VMware"),
        "0x1234" => Some("QEMU"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn format_gpu_fallback_name(vendor: Option<&str>, device_id: Option<&str>) -> Option<String> {
    match (vendor, device_id) {
        (Some(vendor), Some(device_id)) => Some(format!("{vendor} GPU ({device_id})")),
        (Some(vendor), None) => Some(format!("{vendor} GPU")),
        (None, Some(device_id)) => Some(format!("GPU ({device_id})")),
        (None, None) => None,
    }
}
