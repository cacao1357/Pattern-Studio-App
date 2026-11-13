"""Inference structure for the supplied gts2-tex-seed42 checkpoint.

Adapted from the training project's scripts/gts_net.py. Deployment fixes alpha
to zero, so the texture branch is loaded strictly but is not evaluated. No
pretrained encoder download or training-project import is needed.
"""

import torch.nn as nn
import segmentation_models_pytorch as smp


class TextureGatedNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.line = smp.UnetPlusPlus(
            encoder_name="tu-hrnet_w18", encoder_weights=None,
            in_channels=3, classes=1, activation=None,
        )
        channels = self.line.encoder.out_channels[2] + 10
        self.gate = nn.Module()
        self.gate.block = nn.Sequential(
            nn.Conv2d(channels, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, 3, padding=1, bias=False),
            nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 1, 3, padding=1),
        )

    def forward(self, tensor):
        return self.line(tensor)
