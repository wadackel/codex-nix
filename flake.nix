{
  description = "Nix flake for openai/codex (prebuilt binary mirror with cosign-verified auto-updates)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      sources = builtins.fromJSON (builtins.readFile ./sources.json);

      mkCodex =
        pkgs:
        let
          lib = pkgs.lib;
          system = pkgs.stdenv.hostPlatform.system;
          platform =
            sources.platforms.${system}
              or (throw "codex-nix: unsupported system ${system}. Supported: ${lib.concatStringsSep ", " (lib.attrNames sources.platforms)}");
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "codex";
          version = sources.version;
          src = pkgs.fetchurl { inherit (platform) url hash; };

          nativeBuildInputs = [ pkgs.makeWrapper ];

          sourceRoot = ".";
          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            install -Dm755 ${platform.binary} $out/bin/codex
            runHook postInstall
          '';

          postFixup = ''
            wrapProgram $out/bin/codex \
              --prefix PATH : ${lib.makeBinPath [ pkgs.ripgrep ]}
          '';

          meta = with lib; {
            description = "OpenAI Codex CLI (prebuilt binary mirrored from openai/codex releases)";
            homepage = "https://github.com/openai/codex";
            license = licenses.asl20;
            platforms = builtins.attrNames sources.platforms;
            mainProgram = "codex";
            sourceProvenance = with sourceTypes; [ binaryNativeCode ];
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          codex = mkCodex pkgs;
        in
        {
          inherit codex;
          default = codex;
        }
      );

      overlays.default = final: _prev: {
        codex = mkCodex final;
      };

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cosign
              deno
              gh
              just
              nixfmt
            ];
          };
        }
      );

      checks = forAllSystems (system: {
        build = self.packages.${system}.codex;
      });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
