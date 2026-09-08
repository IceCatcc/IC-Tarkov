use std::io::Write;
use std::path::Path;

/// 随包种子清单：与 apidata.rs 的 `embedded_seed` 一一对应。
/// 编译期把每个原始 JSON 用 gzip 压成 `<OUT_DIR>/api-gz/<rel 中 '/' 换成 '__'>.gz`，
/// 运行时由 apidata.rs 内嵌该 .gz 并在读取时解压。
/// 这样 17MB 原始 JSON 只以 ~4MB 的压缩形态进 .so（APK/NSIS 均不再额外膨胀）。
const SEEDS: &[&str] = &[
    "api/regular_tasks.json",
    "api/pve_tasks.json",
    "api/season_tasks.json",
    "api/regular_tasks_zh.json",
    "api/pve_tasks_zh.json",
    "api/regular_maps.json",
    "api/regular_maps_zh.json",
    "api/regular_traders.json",
    "api/regular_traders_zh.json",
    "api/regular_items_zh.json",
    "maps-skeleton.json",
];

fn main() {
    tauri_build::build();

    let manifest = env!("CARGO_MANIFEST_DIR");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("api-gz");
    std::fs::create_dir_all(&out).unwrap();

    for rel in SEEDS {
        let src = Path::new(manifest).join("resources").join(rel);
        let data = std::fs::read(&src)
            .unwrap_or_else(|e| panic!("读取种子失败 {}: {}", rel, e));
        let dst_name = rel.replace('/', "__") + ".gz";
        let dst = out.join(dst_name);
        let f = std::fs::File::create(&dst)
            .unwrap_or_else(|e| panic!("创建 {} 失败: {}", dst.display(), e));
        let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::best());
        enc.write_all(&data).unwrap();
        enc.finish().unwrap();
    }
}
