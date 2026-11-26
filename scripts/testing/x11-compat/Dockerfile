ARG BASE_IMAGE=ubuntu:20.04
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends xvfb openbox xdotool x11-utils x11-apps libstdc++6 ca-certificates libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libsecret-1-0 libnotify4 && rm -rf /var/lib/apt/lists/*
ARG FIXTURE_UID=1000
ARG FIXTURE_GID=1000
RUN groupadd --gid ${FIXTURE_GID} fixture && useradd --uid ${FIXTURE_UID} --gid ${FIXTURE_GID} --create-home fixture
USER fixture
WORKDIR /tmp
CMD ["node", "/fixture/verify.mjs"]
