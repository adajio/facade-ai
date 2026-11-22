// Isolated stream adapter for libarchive. Archive names are never filesystem paths here.
#include <archive.h>
#include <archive_entry.h>
#include <inttypes.h>
#include <limits.h>
#include <locale.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <strings.h>
#include <string.h>
#include <unistd.h>

static const char *archive_issue(struct archive *reader) {
    const char *message = archive_error_string(reader);
    if (message) {
        for (const char *p = message; *p; ++p) {
            if (strncasecmp(p, "encrypt", 7) == 0 || strncasecmp(p, "passphrase", 10) == 0) {
                return "archive_encrypted";
            }
        }
    }
    return "archive_corrupt";
}

static void emit_entry(const char *kind, const char *path) {
    printf("entry %s ", kind);
    if (path) {
        size_t length = strnlen(path, 4097);
        if (length <= 4096) {
            for (size_t i = 0; i < length; ++i) printf("%02x", (unsigned char)path[i]);
        }
    }
    putchar('\n');
}

static int safe_path(const char *path) {
    if (!path || !*path || strnlen(path, 4097) > 4096) return 0;
    if (path[1] == ':') return 0;
    for (const char *start = path; *start;) {
        const char *end = start;
        while (*end && *end != '/' && *end != '\\') {
            unsigned char c = (unsigned char)*end++;
            if (c < 32 || c == 127) return 0;
        }
        size_t length = (size_t)(end - start);
        if (!length || (length == 1 && start[0] == '.') ||
            (length == 2 && start[0] == '.' && start[1] == '.')) return 0;
        start = *end ? end + 1 : end;
    }
    return 1;
}

static const char *extract(struct archive *reader, uint64_t max_bytes, uint64_t max_entries) {
    struct archive_entry *entry;
    uint64_t bytes = 0;
    uint64_t entries = 0;
    unsigned char buffer[65536];

    for (;;) {
        int status = archive_read_next_header(reader, &entry);
        if (status == ARCHIVE_EOF) return entries ? "ok" : "archive_empty";
        if (status < ARCHIVE_WARN || !entry) return archive_issue(reader);
        if (entries++ == max_entries) return "archive_entry_limit";

        const char *path = archive_entry_pathname_utf8(entry);
        mode_t type = archive_entry_filetype(entry);
        int link = archive_entry_hardlink(entry) || archive_entry_symlink(entry);
        const char *kind = type == AE_IFDIR && !link ? "directory" :
            type == AE_IFREG && !link ? "file" : "special";
        emit_entry(kind, path);

        const char *result = "ok";
        if (!safe_path(path)) result = "invalid_source_path";
        else if (archive_entry_is_encrypted(entry)) result = "archive_encrypted";
        else if (link || (type != AE_IFREG && type != AE_IFDIR)) result = "archive_special_entry";
        else if (status < ARCHIVE_OK) result = archive_issue(reader);

        if (strcmp(result, "ok") == 0 && type == AE_IFREG) {
            for (;;) {
                // Read at most one byte beyond the limit to distinguish exact completion.
                uint64_t left = max_bytes - bytes;
                size_t want = left < sizeof(buffer) ? (size_t)left + 1 : sizeof(buffer);
                la_ssize_t length = archive_read_data(reader, buffer, want);
                if (length == 0) break;
                if (length < 0) {
                    result = archive_issue(reader);
                    break;
                }
                if ((uint64_t)length > left) {
                    if (left) {
                        printf("data %" PRIu64 "\n", left);
                        if (fwrite(buffer, 1, (size_t)left, stdout) != left) return "archive_io_error";
                    }
                    puts("end archive_expanded_limit");
                    return "archive_expanded_limit";
                }
                bytes += (uint64_t)length;
                printf("data %jd\n", (intmax_t)length);
                if (fwrite(buffer, 1, (size_t)length, stdout) != (size_t)length) return "archive_io_error";
            }
        }
        if (archive_read_data_skip(reader) < ARCHIVE_WARN && strcmp(result, "ok") == 0) {
            result = archive_issue(reader);
        }
        printf("end %s\n", result);
    }
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    uint64_t max_bytes = strtoull(argv[1], NULL, 10);
    uint64_t max_entries = strtoull(argv[2], NULL, 10);
    unsigned long timeout = strtoul(argv[3], NULL, 10);
    if (timeout == 0 || timeout > UINT_MAX) return 2;
    setlocale(LC_CTYPE, "");
    alarm((unsigned int)timeout);
    struct archive *reader = archive_read_new();
    if (!reader) return 2;
    archive_read_support_format_zip(reader);
    archive_read_support_format_rar(reader);
    archive_read_support_format_rar5(reader);
    archive_read_support_format_7zip(reader);
    int opened = archive_read_open_filename(reader, "/source", 65536);
    const char *result = opened == ARCHIVE_OK
        ? extract(reader, max_bytes, max_entries) : archive_issue(reader);
    printf("done %s\n", result);
    archive_read_free(reader);
    return fflush(stdout) == 0 ? 0 : 2;
}
