# ===========================================================================
# llama-server with CUDA ternary (Q2_0) support for Bonsai Ternary 27B.
#
# Mainline llama.cpp has Q2_0 ternary kernels merged for CPU/Metal only —
# CUDA support is still an open PR upstream (ggml-org/llama.cpp#25707). Until
# that merges, build PrismML-Eng's own fork (branch `prism`), which is what
# their own Bonsai-demo repo uses to get working CUDA ternary inference today.
#
# Pinned by branch for now — move to a specific tag/commit once a build has
# been verified working, so it doesn't silently drift underneath us.
# ===========================================================================
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        git cmake build-essential libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --branch prism --depth 1 https://github.com/PrismML-Eng/llama.cpp .
# ggml-cuda's own CMakeLists correctly finds and links libcuda (driver API,
# for VMM-based memory pooling) via CMake's built-in lib64/stubs fallback —
# confirmed by inspection, it's fine, and libggml-cuda.so itself builds
# cleanly. But building a .so tolerates unresolved dynamic symbols by
# default, deferring them to runtime; modern ld no longer copies transitive
# DT_NEEDED entries, so when the final llama-server *executable* links
# against libggml-cuda.so, libcuda's symbols aren't inherited automatically
# and need to be linked directly on the executable's own link line too.
RUN cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=ON \
        -DCMAKE_EXE_LINKER_FLAGS="-L/usr/local/cuda/lib64/stubs -lcuda" \
    && cmake --build build --target llama-server -j"$(nproc)"

FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        libcurl4 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy the whole bin/ dir rather than globbing *.so — the exact set of
# shared libs (libggml*.so, libllama.so, backend libs) varies by build config
# and an unmatched glob would fail the build.
COPY --from=build /src/build/bin/ /opt/llama-bin/
ENV LD_LIBRARY_PATH=/opt/llama-bin
ENV PATH=/opt/llama-bin:$PATH

ENTRYPOINT ["llama-server"]
