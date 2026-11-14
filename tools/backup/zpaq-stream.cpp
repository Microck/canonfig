// Streaming adapter for public-domain libzpaq 7.15. Build with -DNOJIT on every platform.
// The helper never extracts paths. It reads stdin and writes stdout in binary mode.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
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
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 1;
#endif
  Input input;
  Output output;
  if (!std::strcmp(argv[1], "d")) {
    libzpaq::Decompresser decoder;
    decoder.setInput(&input);
    decoder.setOutput(&output);
    double memory;
    while (decoder.findBlock(&memory)) {
      if (!(memory <= 1024.0 * 1024 * 1024)) libzpaq::error("decompression requires more than 1 GiB");
      while (decoder.findFilename()) {
        decoder.readComment();
        decoder.decompress();
        decoder.readSegmentEnd();
      }
    }
  } else {
    libzpaq::compress(&input, &output, "5");
  }
  return std::ferror(stdin) || std::fflush(stdout) ? 1 : 0;
}
