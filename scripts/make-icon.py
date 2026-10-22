from PIL import Image, ImageDraw, ImageFont
import os

size = 1024
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

gradient = Image.new("RGBA", (size, size))
gd = ImageDraw.Draw(gradient)
start = (91, 140, 255)
end = (167, 139, 250)
for y in range(size):
    t = y / (size - 1)
    color = tuple(int(start[i] + (end[i] - start[i]) * t) for i in range(3)) + (255,)
    gd.line([(0, y), (size, y)], fill=color)

mask = Image.new("L", (size, size), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([48, 48, size - 48, size - 48], radius=210, fill=255)
img.paste(gradient, (0, 0), mask)

draw = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 430)
except Exception:
    font = ImageFont.load_default()

text = "LA"
box = draw.textbbox((0, 0), text, font=font)
tw, th = box[2] - box[0], box[3] - box[1]
x = (size - tw) / 2 - box[0]
y = (size - th) / 2 - box[1] - 10
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

# subtle inner highlight
draw.rounded_rectangle([60, 60, size - 60, size - 60], radius=198, outline=(255, 255, 255, 60), width=6)

os.makedirs("build", exist_ok=True)
img.save("build/icon.png")
img.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icons written")
