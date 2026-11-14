// Benchmark-only adapter to the public-domain libzpaq 7.15 streaming API.
// Build with: c++ -O2 -DNDEBUG -DNOJIT -I<zpaq-source> zpaq-stream.cpp <zpaq-source>/libzpaq.cpp -o zpaq-stream
// Usage: zpaq-stream 5 (compress), zpaq-stream d (decompress).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include "libzpaq.h"

namespace libzpaq {
void error(const char* message) {
  std::fprintf(stderr, "libzpaq: %s\n", message);
  std::exit(1);
}
}

class Input final : public libzpaq::Reader {
 public:
  int get() override { return std::getc(stdin); }
  int read(char* buffer, int length) override {
    return static_cast<int>(std::fread(buffer, 1, length, stdin));
  }
};

class Output final : public libzpaq::Writer {
 public:
  void put(int value) override {
    if (std::putc(value, stdout) == EOF) libzpaq::error("output failed");
  }
  void write(const char* buffer, int length) override {
    if (std::fwrite(buffer, 1, length, stdout) != static_cast<size_t>(length))
      libzpaq::error("output failed");
  }
};

int main(int argc, char** argv) {
  if (argc != 2 || (std::strcmp(argv[1], "5") && std::strcmp(argv[1], "d"))) return 2;
  Input input;
  Output output;
  if (!std::strcmp(argv[1], "d")) libzpaq::decompress(&input, &output);
  else libzpaq::compress(&input, &output, "5");
  return std::ferror(stdin) || std::fflush(stdout) ? 1 : 0;
}
