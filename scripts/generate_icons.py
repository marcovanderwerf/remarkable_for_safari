#!/usr/bin/env python3
"""Generate PNG icons for the reMarkable Safari extension"""

import struct
import zlib
import os

def create_png(width, height, pixels):
    """Create a PNG file from pixel data"""
    def chunk(chunk_type, data):
        chunk_len = struct.pack('>I', len(data))
        chunk_crc = struct.pack('>I', zlib.crc32(chunk_type + data) & 0xffffffff)
        return chunk_len + chunk_type + data + chunk_crc

    # PNG signature
    signature = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    ihdr = chunk(b'IHDR', ihdr_data)

    # IDAT chunk (image data)
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter type: none
        for x in range(width):
            idx = (y * width + x) * 4
            raw_data += bytes(pixels[idx:idx+4])

    compressed = zlib.compress(raw_data, 9)
    idat = chunk(b'IDAT', compressed)

    # IEND chunk
    iend = chunk(b'IEND', b'')

    return signature + ihdr + idat + iend


def create_rm_icon(size):
    """Create an rM logo icon"""
    pixels = []

    # Colors
    bg_color = (41, 41, 41, 255)      # #292929
    text_color = (255, 255, 255, 255)  # white

    # Simple rM representation using pixel art style
    # Scale factor based on size
    scale = size // 16

    # Define a simple 16x16 rM pattern (will be scaled)
    pattern = [
        "................",
        "................",
        "................",
        "...rr...M...M...",
        "...r.r..MM.MM...",
        "...r.r..MM.MM...",
        "...rr...M.M.M...",
        "...r.r..M.M.M...",
        "...r.r..M...M...",
        "...r..r.M...M...",
        "...r..r.M...M...",
        "................",
        "................",
        "................",
        "................",
        "................",
    ]

    for y in range(size):
        for x in range(size):
            # Map to pattern coordinates
            py = min(y // scale, 15)
            px = min(x // scale, 15)

            # Add rounded corners
            corner_radius = size // 6
            in_corner = False

            # Check corners
            if x < corner_radius and y < corner_radius:
                if (corner_radius - x) ** 2 + (corner_radius - y) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x >= size - corner_radius and y < corner_radius:
                if (x - (size - corner_radius - 1)) ** 2 + (corner_radius - y) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x < corner_radius and y >= size - corner_radius:
                if (corner_radius - x) ** 2 + (y - (size - corner_radius - 1)) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x >= size - corner_radius and y >= size - corner_radius:
                if (x - (size - corner_radius - 1)) ** 2 + (y - (size - corner_radius - 1)) ** 2 > corner_radius ** 2:
                    in_corner = True

            if in_corner:
                pixels.extend([0, 0, 0, 0])  # transparent
            elif py < len(pattern) and px < len(pattern[py]) and pattern[py][px] != '.':
                pixels.extend(text_color)
            else:
                pixels.extend(bg_color)

    return pixels


def create_simple_rm_icon(size):
    """Create a cleaner rM logo icon"""
    pixels = []

    bg_color = (41, 41, 41, 255)
    text_color = (255, 255, 255, 255)

    corner_radius = size // 6

    for y in range(size):
        for x in range(size):
            # Check rounded corners
            in_corner = False
            if x < corner_radius and y < corner_radius:
                if (corner_radius - x) ** 2 + (corner_radius - y) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x >= size - corner_radius and y < corner_radius:
                if (x - (size - corner_radius - 1)) ** 2 + (corner_radius - y) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x < corner_radius and y >= size - corner_radius:
                if (corner_radius - x) ** 2 + (y - (size - corner_radius - 1)) ** 2 > corner_radius ** 2:
                    in_corner = True
            elif x >= size - corner_radius and y >= size - corner_radius:
                if (x - (size - corner_radius - 1)) ** 2 + (y - (size - corner_radius - 1)) ** 2 > corner_radius ** 2:
                    in_corner = True

            if in_corner:
                pixels.extend([0, 0, 0, 0])
            else:
                # Create "rM" text area (centered)
                # Normalize coordinates to 0-1 range
                nx = x / size
                ny = y / size

                # Text region roughly in center
                in_text = False

                # Simplified "r" shape (left side)
                if 0.15 <= nx <= 0.40 and 0.30 <= ny <= 0.70:
                    # Vertical stem of r
                    if 0.15 <= nx <= 0.22:
                        in_text = True
                    # Top curve of r
                    elif 0.30 <= ny <= 0.42 and 0.22 <= nx <= 0.38:
                        in_text = True

                # Simplified "M" shape (right side)
                if 0.42 <= nx <= 0.85 and 0.30 <= ny <= 0.70:
                    # Left stem
                    if 0.42 <= nx <= 0.50:
                        in_text = True
                    # Right stem
                    elif 0.77 <= nx <= 0.85:
                        in_text = True
                    # Left diagonal
                    elif 0.30 <= ny <= 0.50:
                        diag_x = 0.50 + (ny - 0.30) * 0.7
                        if abs(nx - diag_x) < 0.06:
                            in_text = True
                    # Right diagonal
                    elif 0.30 <= ny <= 0.50:
                        diag_x = 0.77 - (ny - 0.30) * 0.7
                        if abs(nx - diag_x) < 0.06:
                            in_text = True

                if in_text:
                    pixels.extend(text_color)
                else:
                    pixels.extend(bg_color)

    return pixels


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    images_dir = os.path.join(script_dir, 'extension', 'images')

    os.makedirs(images_dir, exist_ok=True)

    sizes = [16, 32, 48, 64, 96, 128, 256, 512]

    for size in sizes:
        print(f"Generating {size}x{size} icon...")
        pixels = create_simple_rm_icon(size)
        png_data = create_png(size, size, pixels)

        filename = os.path.join(images_dir, f'icon-{size}.png')
        with open(filename, 'wb') as f:
            f.write(png_data)
        print(f"  Created {filename}")

    # Also create Icon.png (128x128) for Xcode
    print("Generating Icon.png...")
    pixels = create_simple_rm_icon(128)
    png_data = create_png(128, 128, pixels)
    with open(os.path.join(images_dir, 'Icon.png'), 'wb') as f:
        f.write(png_data)

    print("\nDone! PNG icons created.")


if __name__ == '__main__':
    main()
