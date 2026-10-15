use std::io::Write;
use std::path::Path;

/// 随包种子清单：与 apidata.rs 的 `ENDPOINTS` 对应（外加地图骨架）。
///
/// 这些 JSON **不入库**（见根 .gitignore），打包前由 `scripts/fetch-api-data.mjs`
/// 抓取；文件缺失时此处只跳过、不再 panic——
///   - 完整版：构建前跑过抓取，全部内嵌；
///   - 无内置数据版（`IC_NO_SEED=1`）：一个都不内嵌，数据由用户首次启动时下载。
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

    // 种子文件变化（新增/删除/内容变化）必须重跑本脚本，否则会沿用上一次的 .gz；
    // IC_NO_SEED 决定这一版是否内嵌，同样要参与「是否需要重编」的判断。
    println!("cargo:rerun-if-changed=resources/api");
    println!("cargo:rerun-if-changed=resources/maps-skeleton.json");
    println!("cargo:rerun-if-env-changed=IC_NO_SEED");

    let manifest = env!("CARGO_MANIFEST_DIR");
    let out = Path::new(&std::env::var("OUT_DIR").unwrap()).join("api-gz");
    std::fs::create_dir_all(&out).unwrap();

    let no_seed = std::env::var_os("IC_NO_SEED").is_some();
    let mut arms = String::new();
    let mut missing: Vec<&str> = Vec::new();

    for rel in SEEDS {
        if no_seed {
            continue;
        }
        let src = Path::new(manifest).join("resources").join(rel);
        let data = match std::fs::read(&src) {
            Ok(d) => d,
            Err(_) => {
                missing.push(rel);
                continue;
            }
        };
        // 编译期把原始 JSON 用 gzip 压成 <OUT_DIR>/api-gz/<rel 中 '/' 换成 '__'>.gz，
        // 运行时由 apidata.rs 内嵌该 .gz 并在读取时解压：17MB 原始 JSON
        // 只以 ~4MB 的压缩形态进二进制（APK/NSIS 均不再额外膨胀）。
        let dst = out.join(rel.replace('/', "__") + ".gz");
        let f = std::fs::File::create(&dst)
            .unwrap_or_else(|e| panic!("创建 {} 失败: {}", dst.display(), e));
        let mut enc = flate2::write::GzEncoder::new(f, flate2::Compression::best());
        enc.write_all(&data).unwrap();
        enc.finish().unwrap();
        arms.push_str(&format!(
            "        {:?} => Some(include_bytes!({:?}).as_slice()),\n",
            rel,
            dst.to_string_lossy().replace('\\', "/")
        ));
    }

    // 生成种子表（apidata.rs 用 include! 引入）：表里没有的键即「没有种子」
    let table = format!(
        "// 由 src-tauri/build.rs 生成，勿手改：随包种子（gzip 字节）表。\n\
         // 缺失或未启用的文件不在表里，读取方据此走「无种子」分支。\n\
         pub fn gzipped(rel: &str) -> Option<&'static [u8]> {{\n    match rel {{\n\
         {arms}        _ => None,\n    }}\n}}\n"
    );
    std::fs::write(out.join("seed_table.rs"), table).unwrap();

    if no_seed {
        println!("cargo:warning=IC_NO_SEED 已设置：本版不内嵌随包种子，数据由用户首次启动时联网下载");
    } else if !missing.is_empty() {
        println!(
            "cargo:warning=随包种子缺失 {} 个（{}）：这些数据会在用户首次启动时联网下载；\
             运行 npm run data:fetch 可补齐后再打包",
            missing.len(),
            missing.join(", ")
        );
    }
}
