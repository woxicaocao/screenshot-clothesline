"""准备公开发布资料，原交付仅复制读取；拒绝覆盖已存在的发布包。"""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
import argparse
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'release' / 'v0.8.6'
parser = argparse.ArgumentParser(description='准备GitHub发布资料，保留原交付与既有准备包')
parser.add_argument('--folder', default='github-release', help='release/v0.8.6 下的新资料目录名称')
args = parser.parse_args()
if Path(args.folder).name != args.folder or args.folder in ('', '.', '..'):
    parser.error('folder 必须是一个新目录名称')
DEST = RELEASE / args.folder
ORIGINAL_ZIP = RELEASE / 'screenshot-clothesline-0.8.6-win-x64.zip'
VIDEO_NAME = '截图晾衣架功能演示_0.8.6OK.mp4'
EXPECTED_ZIP = 'cd5106508ee1cc7537755591f071e6be8940aa7aa8e70654a3cadf4709474cbe'
EXPECTED_VIDEO = 'b0aecd31f41f84a2a3330080c228ee6358d4468fc1c050acca96c01d834218e4'


def sha(file):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def public_files():
    files = [ROOT / name for name in ('README.md', 'LICENSE', 'CONTRIBUTING.md',
             'package.json', 'package-lock.json', '.gitignore') if (ROOT / name).is_file()]
    for folder in ('src', 'test', 'scripts', 'docs'):
        for file in (ROOT / folder).rglob('*'):
            if not file.is_file():
                continue
            rel = file.relative_to(ROOT).as_posix()
            if rel in ('scripts/extension-smoke.cjs', 'scripts/showcase-assets.cjs'):
                continue
            if rel.startswith('docs/showcase/预览截图/') or file.suffix.lower() == '.mp4':
                continue
            if rel in ('docs/showcase/验收记录.json', 'docs/showcase/发布准备说明.md'):
                continue
            files.append(file)
    return sorted(set(files), key=lambda f: f.relative_to(ROOT).as_posix())


def main():
    assert sha(ORIGINAL_ZIP) == EXPECTED_ZIP, '原程序包校验与已交付版不符'
    assert sha(RELEASE / VIDEO_NAME) == EXPECTED_VIDEO, '原视频校验不符'
    assert (ROOT / 'docs/使用手册.md').read_bytes() == (RELEASE / '使用说明.md').read_bytes(), '完整手册应保留原文'
    required = ['hero.png', 'auto-capture.png', 'video-cover.png', 'paste.png',
                'preview.png', 'floating.png', 'export.png', 'notes.png', 'auto-hide.png']
    for name in required:
        assert (ROOT / 'docs/media' / name).is_file(), f'缺少展示图：{name}'
    DEST.mkdir(parents=True, exist_ok=True)
    targets = ['screenshot-clothesline-0.8.6-win-x64.zip',
               'screenshot-clothesline-0.8.6-source.zip', VIDEO_NAME,
               'demo-preview.mp4', '使用说明.md', 'LICENSE-MIT.txt', 'SHA256SUMS.txt', '发布清单.json']
    if any((DEST / name).exists() for name in targets):
        raise FileExistsError('发布准备目录已有同名资料，保留现有文件；请检查后使用另一个目录')

    portable = DEST / targets[0]
    shutil.copy2(ORIGINAL_ZIP, portable)
    with zipfile.ZipFile(portable, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
        assert 'LICENSE-MIT.txt' not in archive.namelist(), '避免生成同名ZIP条目'
        archive.write(ROOT / 'LICENSE', 'LICENSE-MIT.txt')
    with zipfile.ZipFile(ORIGINAL_ZIP) as before, zipfile.ZipFile(portable) as after:
        originals = before.infolist()
        assert len(after.infolist()) == len(originals) + 1
        assert {(info.filename, info.CRC, info.file_size) for info in originals} <= {
            (info.filename, info.CRC, info.file_size) for info in after.infolist()}
        assert after.read('LICENSE-MIT.txt') == (ROOT / 'LICENSE').read_bytes()

    files = public_files()
    source = DEST / targets[1]
    with zipfile.ZipFile(source, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in files:
            archive.write(file, file.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(source) as archive:
        assert len(archive.infolist()) == len(files)
        for file in files:
            assert archive.read(file.relative_to(ROOT).as_posix()) == file.read_bytes()
        assert archive.testzip() is None

    for src, dst in [(RELEASE / VIDEO_NAME, VIDEO_NAME),
                     (ROOT / 'docs/media/demo-preview.mp4', 'demo-preview.mp4'),
                     (ROOT / 'docs/使用手册.md', '使用说明.md'),
                     (ROOT / 'LICENSE', 'LICENSE-MIT.txt')]:
        shutil.copy2(src, DEST / dst)
    assert sha(ORIGINAL_ZIP) == EXPECTED_ZIP
    assert sha(RELEASE / VIDEO_NAME) == EXPECTED_VIDEO
    assert (DEST / 'demo-preview.mp4').stat().st_size < 9500000
    assets = [{ 'name': name, 'bytes': (DEST / name).stat().st_size, 'sha256': sha(DEST / name) }
              for name in targets[:-2]]
    (DEST / 'SHA256SUMS.txt').write_text(''.join(f"{item['sha256']}  {item['name']}\n" for item in assets), encoding='utf-8')
    report = { 'created': datetime.now(timezone.utc).isoformat(),
               'repository': 'https://github.com/woxicaocao/screenshot-clothesline',
               'tag': 'v0.8.6', 'status': '本地资料已准备；等待视觉反馈后发布，尚未上传',
               'portableChange': '仅加入根目录LICENSE-MIT.txt，原ZIP条目、程序与依赖不变',
               'originalZipPreserved': sha(ORIGINAL_ZIP), 'originalVideoPreserved': sha(RELEASE / VIDEO_NAME),
               'sourceFileCount': len(files), 'sourceFiles': [f.relative_to(ROOT).as_posix() for f in files],
               'assets': assets }
    (DEST / '发布清单.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'sourceFiles'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
