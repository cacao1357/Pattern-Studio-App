"""Reference-guided 512 px inpainting with the delivered LeftRefill prompt."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


MODEL_DIR = Path(__file__).resolve().parent
PROMPT_KEY = "cond_stage_model.special_embeddings.weight"
SIZE = (512, 512)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_assets(base_model):
    """Verify the supplied prompt and exact offline SD2 conversion before loading."""
    spec = json.loads((MODEL_DIR / "inference.json").read_text(encoding="utf-8"))
    files = [(MODEL_DIR / spec["prompt"]["file"], spec["prompt"]["sha256"])]
    files.extend((Path(base_model) / name, digest) for name, digest in spec["base_model"]["files"].items())
    for path, expected in files:
        if not path.is_file():
            raise FileNotFoundError(f"Missing model asset: {path}")
        if sha256(path) != expected:
            raise ValueError(f"Model asset SHA-256 mismatch: {path}")
    return spec


def prepare_inputs(target, mask, reference):
    """White mask pixels indicate damage. Preserve native target coordinates."""
    if target.size != SIZE or mask.size != SIZE:
        raise ValueError("Target and mask must both be 512 x 512 pixels")
    target = target.convert("RGB")
    mask = mask.convert("L")
    missing = np.asarray(mask)
    if not np.isin(missing, (0, 255)).all() or not missing.any():
        raise ValueError("Mask must be binary 0/255 and contain white damaged pixels")
    reference = reference.convert("RGB").resize(SIZE, Image.Resampling.BICUBIC)
    pixels = np.concatenate((np.asarray(reference), np.asarray(target)), axis=1)
    rgb = (pixels.astype(np.float32) / 127.5 - 1).transpose(2, 0, 1).copy()
    canvas_mask = np.zeros((1, 512, 1024), dtype=np.float32)
    canvas_mask[0, :, 512:] = missing.astype(np.float32) / 255
    return target, mask, rgb, canvas_mask


class LeftRefill:
    """Load once and reuse. Calls use the validation's DDIM-20 / CFG-2.5 recipe."""

    def __init__(self, base_model, *, sequential_guidance=False):
        spec = verify_assets(base_model)
        import torch
        from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel
        from safetensors.torch import load_file
        from transformers import CLIPTextModel

        if not torch.cuda.is_available():
            raise RuntimeError("LeftRefill requires a CUDA-enabled PyTorch installation and GPU")
        self.torch = torch
        self.device = torch.device("cuda", torch.cuda.current_device())
        self.sequential_guidance = sequential_guidance
        base_model = Path(base_model)
        tokens = load_file(str(MODEL_DIR / spec["prompt"]["file"]))[PROMPT_KEY]
        if tokens.shape != (50, 1024) or not torch.isfinite(tokens).all():
            raise ValueError("Expected 50 finite 1024-dimensional prompt tokens")

        class PromptEmbedding(torch.nn.Module):
            def __init__(self, original):
                super().__init__()
                self.original = original.requires_grad_(False)
                self.special = torch.nn.Embedding.from_pretrained(tokens.float(), freeze=True)
                self.vocab_size = original.num_embeddings

            def forward(self, ids):
                regular = self.original(ids.clamp(max=self.vocab_size - 1))
                special = self.special((ids - self.vocab_size).clamp(min=0))
                return torch.where((ids >= self.vocab_size).unsqueeze(-1), special, regular)

        text = CLIPTextModel.from_pretrained(
            base_model / "text_encoder", variant="fp16", torch_dtype=torch.float32,
            local_files_only=True,
        ).eval().requires_grad_(False)
        if (text.config.num_hidden_layers, text.config.vocab_size) != (23, 49408):
            raise ValueError("Expected the training conversion's 23-block SD2 text encoder")
        text.set_input_embeddings(PromptEmbedding(text.get_input_embeddings()))
        text.to(self.device)
        ids = torch.zeros((2, 77), dtype=torch.long, device=self.device)
        ids[:, 0] = 49406
        ids[0, 1] = 49407
        ids[1, 1:51] = torch.arange(49408, 49458, device=self.device)
        ids[1, 51] = 49407
        with torch.inference_mode():
            self.context = text(ids).last_hidden_state.half()
        del text
        torch.cuda.empty_cache()

        self.unet = UNet2DConditionModel.from_pretrained(
            base_model / "unet", variant="fp16", torch_dtype=torch.float16,
            local_files_only=True,
        ).eval().requires_grad_(False).to(self.device)
        self.vae = AutoencoderKL.from_pretrained(
            base_model / "vae", variant="fp16", torch_dtype=torch.float16,
            local_files_only=True,
        ).eval().requires_grad_(False).to(self.device)
        self.scheduler = DDIMScheduler.from_pretrained(base_model / "scheduler", local_files_only=True)
        if self.unet.config.in_channels != 9 or self.scheduler.config.prediction_type != "epsilon":
            raise ValueError("Expected a 9-channel epsilon-prediction inpainting model")

    def restore(self, target, mask, reference, *, seed=23407):
        target, mask, rgb, canvas_mask = prepare_inputs(target, mask, reference)
        torch = self.torch
        with torch.inference_mode(), torch.random.fork_rng(devices=[self.device.index]):
            torch.manual_seed(seed)
            rgb = torch.as_tensor(rgb[None], device=self.device, dtype=torch.float16)
            canvas_mask = torch.as_tensor(canvas_mask[None], device=self.device, dtype=torch.float16)
            # Retain the validation's first VAE draw so subsequent noise draws align.
            clean = self.vae.encode(rgb).latent_dist.sample()
            masked = self.vae.encode(rgb * (1 - canvas_mask)).latent_dist.sample()
            small_mask = torch.nn.functional.interpolate(canvas_mask, size=clean.shape[-2:], mode="nearest")
            condition = torch.cat((small_mask, masked * self.vae.config.scaling_factor), dim=1)
            noisy = torch.randn((1, 4, *clean.shape[-2:]), device=self.device, dtype=torch.float16)
            del clean
            self.scheduler.set_timesteps(20, device=self.device)
            for timestep in self.scheduler.timesteps:
                inputs = torch.cat((noisy, condition), dim=1)
                if self.sequential_guidance:
                    negative = self.unet(inputs, timestep, encoder_hidden_states=self.context[:1]).sample
                    positive = self.unet(inputs, timestep, encoder_hidden_states=self.context[1:]).sample
                else:
                    negative, positive = self.unet(
                        inputs.repeat(2, 1, 1, 1), timestep, encoder_hidden_states=self.context,
                    ).sample.chunk(2)
                noise = negative.float() + 2.5 * (positive.float() - negative.float())
                noisy = self.scheduler.step(noise, timestep, noisy.float(), eta=1.0).prev_sample.half()
            prediction = self.vae.decode(noisy / self.vae.config.scaling_factor).sample.float().clamp(-1, 1)
            if not torch.isfinite(prediction).all():
                raise RuntimeError("LeftRefill produced non-finite output")
            pixels = ((prediction[0, :, :, 512:].permute(1, 2, 0) + 1) * 127.5).round().byte().cpu().numpy()
        return Image.composite(Image.fromarray(pixels), target, mask)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model", type=Path, required=True, help="Offline SD2 directory matching inference.json")
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True, help="512px binary mask; white = damaged")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New PNG output path")
    parser.add_argument("--seed", type=int, default=23407)
    parser.add_argument("--sequential-guidance", action="store_true", help="Lower-memory CFG; may alter floating-point results")
    args = parser.parse_args()
    if args.output.suffix.lower() != ".png":
        parser.error("Output must use the .png extension")
    if args.output.exists() or args.output.resolve() in {p.resolve() for p in (args.target, args.mask, args.reference)}:
        parser.error("Choose a new output path to preserve existing images")
    with Image.open(args.target) as source, Image.open(args.mask) as mask, Image.open(args.reference) as reference:
        target, missing, _, _ = prepare_inputs(source, mask, reference)
        reference = reference.convert("RGB")
    pipeline = LeftRefill(args.base_model, sequential_guidance=args.sequential_guidance)
    result = pipeline.restore(target, missing, reference, seed=args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("xb") as stream:
        result.save(stream, format="PNG")
    print(json.dumps({"output": str(args.output), "global_step": 1108, "seed": args.seed,
                      "sequential_guidance": args.sequential_guidance}, ensure_ascii=False))


if __name__ == "__main__":
    main()
