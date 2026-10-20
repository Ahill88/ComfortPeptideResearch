"""Original procedural studio photography-style concept renders.
Usage: Blender --background --python tools/catalog-art/render.py -- [slug] [view]
Outputs 2048px PNG masters; use optimize.py for responsive WebP delivery.
No verified packaging, purity, quantity, or facility claims are depicted.
"""
import bpy
import math
import sys
from mathutils import Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tools/catalog-art/masters'
OUT.mkdir(parents=True, exist_ok=True)
PRODUCTS = {
    'ghk-cu': ((.24, .38, .35, 1), (.80, .87, .83, 1)),
    'bpc-157': ((.21, .17, .10, 1), (.88, .84, .76, 1)),
    'tb-500': ((.20, .14, .30, 1), (.84, .81, .88, 1)),
    'reta': ((.25, .11, .14, 1), (.83, .79, .80, 1)),
    'tirz': ((.10, .24, .34, 1), (.78, .83, .86, 1)),
    'semax': ((.42, .21, .10, 1), (.85, .83, .80, 1)),
    'selank': ((.10, .38, .31, 1), (.79, .84, .82, 1)),
    'klow': ((.36, .15, .06, 1), (.82, .80, .78, 1)),
    'ipamorelin': ((.17, .22, .34, 1), (.78, .82, .86, 1)),
    'tesamorelin': ((.22, .14, .30, 1), (.81, .79, .84, 1)),
    'mots-c': ((.19, .28, .11, 1), (.79, .82, .77, 1)),
    'nad-plus': ((.36, .21, .06, 1), (.84, .82, .79, 1)),
    'kpv': ((.24, .11, .18, 1), (.81, .79, .82, 1)),
    'epithalon': ((.10, .28, .34, 1), (.78, .83, .85, 1)),
    'thymosin-alpha-1': ((.18, .28, .18, 1), (.79, .82, .79, 1)),
    'cjc-1295-ipamorelin': ((.15, .22, .34, 1), (.78, .82, .86, 1)),
    'bac-water': ((.29, .28, .24, 1), (.80, .79, .77, 1)),
}
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
slug = args[0] if args else 'ghk-cu'
view = args[1] if len(args) > 1 else 'overview'
accent, background = PRODUCTS[slug]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 96
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 10
scene.cycles.transmission_bounces = 8
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for device in prefs.devices:
    device.use = device.type == 'METAL'
# CPU is also available for hosts where the Metal driver aborts on world lighting.
scene.cycles.device = 'CPU' if '--cpu' in args else 'GPU'
scene.render.resolution_x = 2048
scene.render.resolution_y = 2048
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.world.use_nodes = True
world_bg = scene.world.node_tree.nodes.get('Background')
world_bg.inputs['Color'].default_value = (.85, .89, .86, 1)
world_bg.inputs['Strength'].default_value = .65
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.view_settings.exposure = .35

def mat(name, color, metallic=0.0, roughness=.35, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Transmission Weight'].default_value = transmission
    bsdf.inputs['IOR'].default_value = 1.46
    return m

glass = mat('Frosted optical glass', (.93, .98, .96, 1), roughness=.16, transmission=.94)
silver = mat('Brushed aluminum', (.68, .73, .75, 1), metallic=.88, roughness=.24)
capmat = mat('Mineral colored cap', accent, metallic=.12, roughness=.29)
rubber = mat('Dark recessed closure', (.085, .105, .10, 1), roughness=.65)
base = mat('Pale porcelain pedestal', (.79, .82, .79, 1), roughness=.32)
floor = mat('Seamless mineral studio', background, roughness=.78)
powder = mat('Abstract off white insert', (.88, .90, .87, 1), roughness=.8)

def cyl(name, radius, depth, z, material, vertices=192, bevel=.035):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=(0, 0, z))
    o = bpy.context.object
    o.name = name
    o.data.materials.append(material)
    if bevel:
        mod = o.modifiers.new('Machined soft edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 4
    o.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    for p in o.data.polygons:
        p.use_smooth = True
    return o

# A real hollow glass body, not an opaque cylinder.
profile = [(0, .23), (.43, .23), (.51, .25), (.56, .32), (.575, .45), (.575, 2.05), (.56, 2.18), (.47, 2.32), (.34, 2.40), (.34, 2.65), (.29, 2.65), (.29, 2.42), (.43, 2.30), (.51, 2.16), (.525, 2.04), (.525, .48), (.50, .39), (.42, .35), (0, .35)]
verts = []
faces = []
n = 192
for r, z in profile:
    verts.extend([(r * math.cos(i*2*math.pi/n), r * math.sin(i*2*math.pi/n), z) for i in range(n)])
for j in range(len(profile)-1):
    for i in range(n):
        k = (i+1) % n
        faces.append((j*n+i, j*n+k, (j+1)*n+k, (j+1)*n+i))
mesh = bpy.data.meshes.new('Hollow vial lathe')
mesh.from_pydata(verts, [], faces)
mesh.update()
o = bpy.data.objects.new('Glass vial', mesh)
bpy.context.collection.objects.link(o)
o.data.materials.append(glass)
for p in o.data.polygons:
    p.use_smooth = True
cyl('Low porcelain display plinth', 1.02, .20, .10, base, bevel=.045)
cyl('Subtle opaque base insert', .49, .08, .40, powder, bevel=.03)
cyl('Closure gasket', .345, .16, 2.57, rubber)
cyl('Aluminum crimp collar', .405, .27, 2.65, silver, bevel=.025)
cyl('Crimp rolled lower lip', .414, .045, 2.52, silver, bevel=.012)
cyl('Aluminum top rim', .42, .06, 2.79, silver, bevel=.02)
cyl('Mineral flip off disk', .389, .10, 2.84, capmat, bevel=.035)
cyl('Inset cap center', .298, .012, 2.897, capmat, bevel=.012)
# Fine real collar fluting catches softbox highlights.
for i in range(88):
    a = 2*math.pi*i/88
    bpy.ops.mesh.primitive_cube_add(size=1, location=(.405*math.cos(a), .405*math.sin(a), 2.65))
    ridge = bpy.context.object
    ridge.name = 'Collar micro flute'
    ridge.scale = (.006, .009, .16)
    ridge.rotation_euler.z = a
    ridge.data.materials.append(silver)
    bevel = ridge.modifiers.new('Soft flute', 'BEVEL')
    bevel.width = .004
    bevel.segments = 2

# Curved physical label with exact typography rather than generated pseudo text.
labelmat = mat('Archival paper label', (1, 1, 1, 1), roughness=.58)
bsdf = labelmat.node_tree.nodes.get('Principled BSDF')
tex = labelmat.node_tree.nodes.new('ShaderNodeTexImage')
tex.image = bpy.data.images.load(str(ROOT / f'tools/catalog-art/labels/{slug}.png'))
labelmat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
verts, faces = [], []
steps = 192
for z in [.69, 1.97]:
    for i in range(steps+1):
        a = -math.pi/2 - 1.43 + 2.86*i/steps
        verts.append((.579*math.cos(a), .579*math.sin(a), z))
for i in range(steps):
    faces.append((i, i+1, steps+2+i, steps+1+i))
mesh = bpy.data.meshes.new('Curved label surface')
mesh.from_pydata(verts, [], faces)
mesh.update()
uv = mesh.uv_layers.new(name='Label UV')
for poly in mesh.polygons:
    poly.use_smooth = True
    for idx in poly.loop_indices:
        vi = mesh.loops[idx].vertex_index
        uv.data[idx].uv = ((vi % (steps+1))/steps, vi//(steps+1))
o = bpy.data.objects.new('Printed paper label', mesh)
bpy.context.collection.objects.link(o)
o.data.materials.append(labelmat)

bpy.ops.mesh.primitive_plane_add(size=200)
o = bpy.context.object
o.name = 'Infinite seamless backdrop'
o.data.materials.append(floor)

def aim(o, target):
    o.rotation_euler = (Vector(target)-o.location).to_track_quat('-Z', 'Y').to_euler()
def area(name, loc, power, size, target, size_y=None):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = power
    data.shape = 'RECTANGLE'
    data.size = size
    data.size_y = size_y or size
    o = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(o)
    o.location = loc
    aim(o, target)
area('Large soft key', (-3.2,-4.4,6), 450, 4, (0,0,1.2))
area('Vertical glass reflection', (2.8,-1.8,3.2), 210, .65, (0,0,1.3), 4)
area('Rear edge separation', (-1,3,4.7), 540, 3, (0,0,1.5))
area('Front label fill', (0,-5,2.4), 65, 3, (0,0,1.4))

bpy.ops.object.camera_add()
cam = bpy.context.object
scene.camera = cam
cam.data.type = 'ORTHO'
if view == 'detail':
    cam.location = (0,-9,3.35)
    cam.data.ortho_scale = 2.15
    aim(cam, (0,0,1.43))
elif view == 'angle':
    cam.location = (3.4,-9,5.7)
    cam.data.ortho_scale = 4.05
    aim(cam, (0,0,1.48))
else:
    cam.location = (.32,-10,4.9)
    cam.data.ortho_scale = 4.05
    aim(cam, (0,0,1.48))
cam.data.lens = 65
scene.render.filepath = str(OUT / f'{slug}-{view}.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / f'{slug}-{view}.blend')) if '--save-scene' in args else None
bpy.ops.render.render(write_still=True)
print('RENDER_COMPLETE', scene.render.filepath)
