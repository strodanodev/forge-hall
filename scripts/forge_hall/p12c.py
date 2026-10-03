O = bpy.data.objects
O["MXI_Hearth"].scale = (1.9, 1.9, 3.7 / O["MX_hearth"].dimensions.z)
if "Fire_Back" in O:
    bpy.data.objects.remove(O["Fire_Back"], do_unlink=True)
print(tuple(round(v, 2) for v in O["MXI_Hearth"].dimensions))
