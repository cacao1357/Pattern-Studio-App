"""Loss-aware geometric preparation for local raster assets."""

import math

from PIL import Image

from app.schemas.contracts import ProcessingError


def _quarter_turn(image: Image.Image, degrees: int) -> Image.Image:
    transpose = {
        0: None,
        90: Image.Transpose.ROTATE_90,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_270,
    }[degrees]
    return image.copy() if transpose is None else image.transpose(transpose)


def _quarter_turn_matrix(width: int, height: int, degrees: int) -> list[list[float]]:
    if degrees == 0:
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    if degrees == 90:
        return [[0.0, 1.0, 0.0], [-1.0, 0.0, float(width)], [0.0, 0.0, 1.0]]
    if degrees == 180:
        return [[-1.0, 0.0, float(width)], [0.0, -1.0, float(height)], [0.0, 0.0, 1.0]]
    return [[0.0, -1.0, float(height)], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]


def _multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
    return [[sum(left[row][i] * right[i][column] for i in range(3)) for column in range(3)]
            for row in range(3)]


def _straighten_geometry(size: tuple[int, int], degrees: float):
    width, height = size
    angle = -math.radians(degrees % 360.0)
    # Match Pillow's 15-decimal reverse affine coefficients and corner
    # rounding used to calculate expand=True dimensions.
    reverse_cosine = round(math.cos(angle), 15)
    reverse_sine = round(math.sin(angle), 15)
    reverse_y_cosine = round(-math.sin(angle), 15)
    reverse_y_sine = round(math.cos(angle), 15)
    center_x, center_y = width / 2.0, height / 2.0
    reverse_tx = reverse_cosine * -center_x + reverse_sine * -center_y + center_x
    reverse_ty = reverse_y_cosine * -center_x + reverse_y_sine * -center_y + center_y

    def reverse(x, y):
        return (reverse_cosine * x + reverse_sine * y + reverse_tx,
                reverse_y_cosine * x + reverse_y_sine * y + reverse_ty)

    corners = ((0, 0), (width, 0), (width, height), (0, height))
    pillow_bounds = tuple(reverse(x, y) for x, y in corners)
    out_width = math.ceil(max(x for x, _ in pillow_bounds)) - math.floor(min(x for x, _ in pillow_bounds))
    out_height = math.ceil(max(y for _, y in pillow_bounds)) - math.floor(min(y for _, y in pillow_bounds))
    cosine = round(math.cos(math.radians(degrees)), 15)
    sine = round(math.sin(math.radians(degrees)), 15)
    # Pixel-edge coordinates use origin at top-left, x right and y down.
    # Positive degrees are counterclockwise, so the forward matrix has +sin
    # in x' and -sin in y'.
    # Pillow centers the expanded canvas. This is the exact edge-coordinate
    # translation used by Image.rotate(..., expand=True).
    tx = (out_width - width) / 2.0 + (1.0 - cosine) * width / 2.0 - sine * height / 2.0
    ty = (out_height - height) / 2.0 + sine * width / 2.0 + (1.0 - cosine) * height / 2.0
    matrix = [[cosine, sine, tx], [-sine, cosine, ty], [0.0, 0.0, 1.0]]
    return (out_width, out_height), matrix, [out_width / 2.0 - width / 2.0, out_height / 2.0 - height / 2.0]


def prepare_image(image: Image.Image, *, rotation: int = 0, straighten: float = 0.0):
    """Return a prepared RGBA image and a reproducible pixel-edge mapping."""
    if type(rotation) is not int or rotation not in {0, 90, 180, 270}:
        raise ProcessingError("INVALID_ROTATION", "Rotation must be one of 0, 90, 180 or 270 degrees")
    if isinstance(straighten, bool) or not isinstance(straighten, (int, float)) or not math.isfinite(straighten) or not -15 <= straighten <= 15:
        raise ProcessingError("INVALID_STRAIGHTEN", "Straighten angle must be in -15..15 degrees")

    original = image.convert("RGBA")
    input_size = original.size
    rotated_size = (input_size[1], input_size[0]) if rotation in {90, 270} else input_size
    quarter_turn = _quarter_turn_matrix(*input_size, rotation)
    no_change = rotation == 0 and float(straighten) == 0.0
    if no_change:
        return original.copy(), {
            "operation": "rotate_and_straighten", "rotation_ccw_degrees": rotation,
            "straighten_ccw_degrees": float(straighten), "input_size": list(input_size),
            "right_angle_size": list(rotated_size), "output_size": list(input_size),
            "coordinate_convention": "pixel_edges; origin top_left; x_right; y_down",
            "rotation_center": [input_size[0] / 2.0, input_size[1] / 2.0],
            "straighten_center": [input_size[0] / 2.0, input_size[1] / 2.0],
            "expand_padding_offset": [0.0, 0.0], "input_to_output": quarter_turn,
            "resampling": "none", "no_change": True,
        }
    right_turned = _quarter_turn(original, rotation)
    expand_offset = [0.0, 0.0]
    if straighten:
        output_size, straight_matrix, expand_offset = _straighten_geometry(rotated_size, float(straighten))
        right_turned = right_turned.convert("RGBa").rotate(
            float(straighten), resample=Image.Resampling.BICUBIC, expand=True,
            fillcolor=(0, 0, 0, 0),
        )
        if right_turned.size != output_size:
            raise ProcessingError("PREPARATION_GEOMETRY_MISMATCH", "Image rotation did not match its recorded coordinate mapping")
    else:
        output_size = rotated_size
        straight_matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    output = right_turned if not straighten else right_turned.convert("RGBA")
    mapping = _multiply(straight_matrix, quarter_turn)
    return output, {
        "operation": "rotate_and_straighten",
        "rotation_ccw_degrees": rotation,
        "straighten_ccw_degrees": float(straighten),
        "input_size": list(input_size),
        "right_angle_size": list(rotated_size),
        "output_size": list(output_size),
        "coordinate_convention": "pixel_edges; origin top_left; x_right; y_down",
        "rotation_center": [input_size[0] / 2.0, input_size[1] / 2.0],
        "straighten_center": [rotated_size[0] / 2.0, rotated_size[1] / 2.0],
        "expand_padding_offset": expand_offset,
        "input_to_output": mapping,
        "resampling": "transpose_exact" if straighten == 0 else "bicubic_premultiplied_rgba",
        "no_change": False,
    }


def prepared_output_size(size: tuple[int, int], rotation: int, straighten: float):
    rotated_size = (size[1], size[0]) if rotation in {90, 270} else size
    if not straighten:
        return rotated_size
    return _straighten_geometry(rotated_size, float(straighten))[0]
