"""Base-URL resolution: WSL must never hardcode the NAT gateway IP, since it
changes across WSL restarts (docs/comfyui-setup.md). COMFYUI_BASE_URL wins
when set; otherwise the Windows host IP comes from the live default route."""

from __future__ import annotations

import subprocess

import pytest

from comfy_client.base_url import (
    DEFAULT_PORT,
    GatewayNotFoundError,
    default_gateway_ip,
    resolve_base_url,
)

IP_ROUTE_OUTPUT = "default via 172.18.192.1 dev eth0 proto kernel\n"


def fake_run(output: str, returncode: int = 0):
    def run(*args, **kwargs):
        if returncode != 0:
            raise subprocess.CalledProcessError(returncode, args)
        return subprocess.CompletedProcess(args, returncode, stdout=output, stderr="")

    return run


def test_default_gateway_ip_parses_via_target():
    assert default_gateway_ip(run=fake_run(IP_ROUTE_OUTPUT)) == "172.18.192.1"


def test_default_gateway_ip_raises_when_no_default_route():
    with pytest.raises(GatewayNotFoundError):
        default_gateway_ip(run=fake_run("10.0.0.0/8 dev eth0 scope link\n"))


def test_resolve_base_url_env_override_wins_and_strips_trailing_slash():
    env = {"COMFYUI_BASE_URL": "http://example.test:9000/"}
    url = resolve_base_url(env=env, run=fake_run(IP_ROUTE_OUTPUT))
    assert url == "http://example.test:9000"


def test_resolve_base_url_falls_back_to_gateway_with_default_port():
    url = resolve_base_url(env={}, run=fake_run(IP_ROUTE_OUTPUT))
    assert url == f"http://172.18.192.1:{DEFAULT_PORT}"


def test_resolve_base_url_honours_comfyui_port_override():
    url = resolve_base_url(env={"COMFYUI_PORT": "8189"}, run=fake_run(IP_ROUTE_OUTPUT))
    assert url == "http://172.18.192.1:8189"


def test_resolve_base_url_propagates_gateway_not_found():
    with pytest.raises(GatewayNotFoundError):
        resolve_base_url(env={}, run=fake_run("10.0.0.0/8 dev eth0 scope link\n"))
