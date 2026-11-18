// 生产构建时隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    image_viewer_lib::run()
}
