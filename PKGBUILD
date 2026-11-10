# Maintainer: ocm contributors
pkgname=ocm
pkgver=0.1.0
pkgrel=1
pkgdesc="Manage OpenCode provider configuration and API-key storage modes"
arch=('x86_64' 'aarch64')
url="https://github.com/yourname/ocm"
license=('MIT')
depends=('glibc' 'gcc-libs' 'icu')
makedepends=('bun')
options=(!strip)
source=("$pkgname-$pkgver.tar.gz::$url/releases/download/v$pkgver/$pkgname-$pkgver.tar.gz")
# PLACEHOLDER: replace with the sha256 of the published GitHub release tarball.
sha256sums=('0000000000000000000000000000000000000000000000000000000000000000')

build() {
  cd "$pkgname-$pkgver"
  bun install --frozen-lockfile
  bun build --compile --outfile dist/ocm src/cli.ts
}

package() {
  cd "$pkgname-$pkgver"
  install -Dm755 dist/ocm "$pkgdir/usr/bin/ocm"
  install -Dm644 completions/ocm.bash "$pkgdir/usr/share/bash-completion/completions/ocm"
  install -Dm644 completions/_ocm "$pkgdir/usr/share/zsh/site-functions/_ocm"
  install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
