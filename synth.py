# Copyright 2018 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""This script is used to synthesize generated parts of this library."""

import synthtool as s
import synthtool.gcp as gcp
import logging
import subprocess

logging.basicConfig(level=logging.DEBUG)

gapic = gcp.GAPICGenerator()
# tasks has two product names, and a poorly named artman yaml
v2_library = gapic.node_library(
    "logging",
    "v2",
    config_path="/google/logging/artman_logging.yaml",
    artman_output_name="logging-v2",
)
s.copy(v2_library, excludes=["src/index.js", "README.md", "package.json"])
s.replace(
    [
        "src/v2/config_service_v2_client.js",
        "src/v2/logging_service_v2_client.js",
        "src/v2/metrics_service_v2_client.js",
    ],
    "../../package.json",
    "../../../package.json",
)

# Copy in templated files
common_templates = gcp.CommonTemplates()
templates = common_templates.node_library(source_location='build/src')
s.copy(templates)

# Node.js specific cleanup
subprocess.run(["npm", "install"])
subprocess.run(["npm", "run", "fix"])
