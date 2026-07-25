import json


async def test_metrics(jp_fetch):
    # When
    response = await jp_fetch("jupyterlab-resource-monitor-extension", "metrics")

    # Then
    assert response.code == 200
    payload = json.loads(response.body)
    assert set(payload) == {"mem", "cpu", "ts"}
    assert set(payload["mem"]) == {"used_bytes", "total_bytes", "limit_source"}
    assert set(payload["cpu"]) == {"percent", "cpu_count"}


async def test_kernels_without_a_kernel_id(jp_fetch):
    response = await jp_fetch("jupyterlab-resource-monitor-extension", "kernels")

    assert response.code == 200
    payload = json.loads(response.body)
    assert set(payload) == {"kernel", "ts"}
    assert payload["kernel"] is None


async def test_kernels_with_an_unknown_kernel_id(jp_fetch):
    # a stale id (kernel died, or another server's) must not error or leak a
    # previous kernel's sample
    response = await jp_fetch(
        "jupyterlab-resource-monitor-extension",
        "kernels",
        params={"kernel_id": "does-not-exist"},
    )

    assert response.code == 200
    assert json.loads(response.body)["kernel"] is None
