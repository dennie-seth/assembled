"""Deterministic looping ambience bed synthesis.

Implements the T-0083 pipeline for looping content
(13-asset-pipeline.md §4.7):
    synthesize (deterministic script)
      -> remove DC offset
      -> loop-fold (deterministic crossfade at the seam)
      -> loudness normalize (EBU R128)
      -> encode (Ogg Vorbis, with explicit LOOP_START comment)
      -> validate ON THE ENCODED FILE
"""
