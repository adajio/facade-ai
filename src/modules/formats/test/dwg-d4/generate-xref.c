#include <stdio.h>
#include <stdlib.h>

#include <dwg.h>
#include <dwg_api.h>

static int write_drawing(const char *path, const char *label, int host) {
    Dwg_Data *dwg = dwg_new_Document(R_2000, 0, 0);
    if (!dwg) return 1;
    dwg->header_vars.INSUNITS = 4;
    Dwg_Object_BLOCK_HEADER *model = dwg_model_space_object(dwg)->tio.object->tio.BLOCK_HEADER;
    const dwg_point_3d text_origin = {0, 80, 0};
    if (!dwg_add_TEXT(model, label, &text_origin, 3)) return 1;
    if (host) {
        Dwg_Object_BLOCK_HEADER *ref = dwg_add_BLOCK_HEADER(dwg, "W34_REF");
        if (!ref) return 1;
        ref->blkisxref = 1;
        ref->xref_pname = dwg_add_u8_input(dwg, "xref-target.dwg");
        const dwg_point_3d insert_origin = {25, 40, 0};
        if (!dwg_add_BLOCK(ref, "W34_REF") || !dwg_add_ENDBLK(ref)
            || !dwg_add_INSERT(model, &insert_origin, "W34_REF", 1, 1, 1, 0)) return 1;
    }
    const int result = dwg_write_file(path, dwg);
    dwg_free(dwg);
    free(dwg);
    return result ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    return write_drawing(argv[1], "W34 HOST | 70 mm", 1)
        || write_drawing(argv[2], "W34 ACCEPTED REFERENCE | 42 mm", 0)
        || write_drawing(argv[3], "W34 STALE REFERENCE | 41 mm", 0)
        || write_drawing(argv[4], "W34 FOREIGN REFERENCE | 99 mm", 0);
}
