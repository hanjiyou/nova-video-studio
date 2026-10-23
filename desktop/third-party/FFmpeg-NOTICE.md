# FFmpeg media decoder

Nova Studio uses a separate FFmpeg executable for complete local image/video decoding. It does not execute FFmpeg via a shell or use a PATH-installed copy.

The locked npm package is ffmpeg-static 5.3.0. The audited Windows x64 binary is **FFmpeg 6.1.1-essentials_build-www.gyan.dev**, built with GCC 12.2.0 and `--enable-gpl --enable-version3 --enable-static`. Its actual license is GPL version 3 or later. The package version is not the FFmpeg binary version. Other platforms have not received this B2 packaging audit.

Binary download: https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz

SHA-256 of the decompressed executable: `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`.

The upstream build identifies FFmpeg source commit https://github.com/FFmpeg/FFmpeg/commit/e38092ef93. The executable's accompanying README lists build configuration and the revisions of linked libraries, including x264/x265, libvpx, libwebp and others. The complete upstream README and the actual binary GPL license accompany this local Windows test package in `resources/licenses/`. FFmpeg is copyright its respective authors and is provided without warranty under that license.

This repository's AGPL license does not replace the separate decoder's GPL obligations. Before public installer distribution, provide corresponding source, linked-library source and the scripts/build materials required by GPL section 6 through a compliant distribution method. Preserve the actual notices and licenses and make the source available with the binary offering. **An upstream commit link or this notice alone is not asserted to fulfill corresponding-source delivery.** T16 has collected 33 upstream source archives beside the local installer, including FFmpeg at the declared revision and x264 identified directly from the pinned encoder SEI. The archive hashes and the missing items are listed in FFmpeg-SOURCE-STATUS.json and the T16 evidence. These upstream archives are partial evidence: exact transitive-library revisions, local patches and the Gyan recipe/toolchain remain unproven. Local test builds only; public redistribution remains an explicit T16 release gate.

The runtime restricts decoding to a detected-format demuxer and a local-file input, disables network input protocols, uses no stdin, and limits elapsed time, CPU thread count, per-allocation size, frames, pixels and decoder output. Successful container/header parsing alone does not mark an asset verified; every emitted video/audio frame must decode successfully.
