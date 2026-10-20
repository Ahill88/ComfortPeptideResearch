#!/usr/bin/env python3
"""Original procedural studio hero render — generic vial on pedestal.
Usage: Blender --background --python tools/catalog-art/render-hero.py -- [view]
Outputs 3840×2048 PNG master for the hero section.
No verified packaging, purity, quantity, or facility claims are depicted.
"""
import bpy, math, sys
from mathutils import Vector
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/storefront/public/media/hero'
OUT.mkdir(parents=True, exist_ok=True)

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
view = args[0] if args else 'hero'

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 128
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 12
scene.cycles.transmission_bounces = 10

prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for device in prefs.devices:
    device.use = device.type == 'METAL'

scene.cycles.device = 'CPU' if '--cpu' in args else 'GPU'

# Hero uses wide aspect ratio — 16:9
scene.render.resolution_x = 3840
scene.render.resolution_y = 2160
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.view_settings.exposure = .25

# Dark studio background
scene.world.use_nodes = True
world_bg = scene.world.node_tree.nodes.get('Background')
world_bg.inputs['Color'].default_value = (.04, .05, .07, 1)  # Deep midnight
world_bg.inputs['Strength'].default_value = .55

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
silver = mat('Brushed aluminum', (.62, .68, .71, 1), metallic=.88, roughness=.24)
capmat = mat('Mineral colored cap', (.22, .28, .26, 1), metallic=.12, roughness=.29)
rubber = mat('Dark recessed closure', (.085, .105, .10, 1), roughness=.65)
base = mat('Pale porcelain pedestal', (.74, .77, .74, 1), roughness=.32)
floor = mat('Dark mineral studio', (.04, .05, .07, 1), roughness=.82)

# Vial body — same hollow glass lathe profile
profile = [(0, .23), (.43, .23), (.51, .25), (.56, .32), (.575, .45), (.575, 2.05), (.56, 2.18), (.47, 2.32), (.34, 2.40), (.34, 2.65), (.29, 2.65), (.29, 2.42), (.43, .30), (.51, .16), (.525, .204), (.525, .48), (.50, .39), (.42, .35), (0, .35)]
verts, faces = [], []
n = 192
for r, z in profile:
    verts.extend([(r * math.cos(i*2*math.pi/n), r * math.sin(i*2*math.pi/n), z) for i in range(n)])
for j in range(len(profile)-1):
    for i in range(n):
        k = (i+1) % n
        faces.append((j*n+i, j*n+k, (j+1)*n+k, (j+1)*n+i))
mesh = bpy.data.meshes.new('Hero vial lathe')
mesh.from_pydata(verts, [], faces)
mesh.update()
o = bpy.data.objects.new('Glass vial', mesh)
bpy.context.collection.objects.link(o)
o.data.materials.append(glass)
for p in o.data.polygons:
    p.use_smooth = True

# Pedestal
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

cyl('Porcelain display plinth', 1.1, .20, .10, base, bevel=.045)
cyl('Inset cap center', .298, .012, 2.897, capmat, bevel=.012)

# Closure gasket, crimp collar, cap
cyl('Closure gasket', .345, .16, 2.57, rubber)
cyl('Aluminum crimp collar', .405, .27, 2.65, silver, bevel=.025)
cyl('Crimp rolled lower lip', .414, .045, 2.52, silver, bevel=.012)
cyl('Aluminum top rim', .42, .06, 2.79, silver, bevel=.02)
cyl('Mineral flip off disk', .389, .10, 2.84, capmat, bevel=.035)

# Collar fluting
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

# Seamless backdrop
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

area('Large soft key', (-3.2,-4.4,6), 500, 4, (0,0,1.2))
area('Vertical glass reflection', (2.8,-1.8,3.2), 240, .65, (0,0,1.3), 4)
area('Rear edge separation', (-1,3,4.7), 580, 3, (0,0,1.5))
area('Front label fill', (0,-5,2.4), 80, 3, (0,0,1.4))

# Camera
bpy.ops.object.camera_add()
cam = bpy.context.object
scene.camera = cam
cam.data.type = 'ORTHO'

if view == 'close':
    cam.location = (0,-8,3.5)
    cam.data.ortho_scale = 2.5
elif view == 'wide':
    cam.location = (1.2,-12,5.5)
    cam.data.ortho_scale = 5.0
else:
    cam.location = (.32,-10,4.9)
    cam.data.ortho_scale = 4.05

cam.data.lens = 65
cam.data.dof.use_dof = True
cam.data.dof.focus_distance = 1.5

scene.render.filepath = str(OUT / 'hero-studio.png')
bpy.ops.render.render(write_still=True)
print('RENDER_COMPLETE', scene.render.filepath)
