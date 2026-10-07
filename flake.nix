{
  description = "SNOMED Review Web Interface and Terminology Engine";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        packages = rec {
          frontend = pkgs.buildNpmPackage {
            pname = "snomed-review-frontend";
            version = "1.0.0";
            src = ./frontend;
            npmDepsHash = "sha256-DL29zbX82OXRl1nQInunY0efMcZ6Gqd9HoSIGGaGC40=";
            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/snomed-review-frontend
              cp -r dist/* $out/share/snomed-review-frontend/
              runHook postInstall
            '';
          };

          backend = pkgs.rustPlatform.buildRustPackage {
            pname = "snomed_review_backend";
            version = "1.0.0";
            src = ./backend;
            cargoLock = {
              lockFile = ./backend/Cargo.lock;
            };
            nativeBuildInputs = with pkgs; [
              pkg-config
            ];
            buildInputs = with pkgs; [
              openssl
            ];
          };

          default = backend;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            rustc
            cargo
            rustfmt
            clippy
            cargo-watch
            pkg-config
            openssl
            nodejs_22
            corepack_22
            zip
            unzip
          ];

          shellHook = ''
            echo "SNOMED Review Development Shell"
            echo "Rust: $(rustc --version)"
            echo "Node: $(node --version)"
          '';
        };
      }
    );
}
