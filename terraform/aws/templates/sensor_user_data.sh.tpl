#!/bin/bash
# Corelight sensor dual-ENI bring-up fixups (AlmaLinux 9, no amazon-ec2-net-utils).
#
# Layout: eth0 = MONITORING (primary ENI, private subnet, NO internet, receives mirror traffic);
#         eth1 = MANAGEMENT (secondary ENI, public subnet, Elastic IP, SSH + dnf egress + Fleet).
#
# Two problems this solves:
#   1. The primary ENI's DHCP installs the default route out eth0 (monitoring) — but that subnet
#      is private, so the box would have NO internet for `dnf install corelight-sensor`, and SSH
#      replies to the eth1 EIP would leave via eth0 and be dropped (asymmetric routing). We make
#      the MANAGEMENT ENI the default route instead.
#   2. AlmaLinux may not auto-configure the secondary ENI at all (no ec2-net-utils). We add an
#      autoconnecting DHCP NetworkManager connection for each ENI, keyed by MAC.
#
# Everything is keyed on MAC (not kernel name) so it survives the eth0/eth1 rename below and the
# reboot that `corelightctl sensor deploy` performs.
set -uo pipefail

MGMT_MAC="${mgmt_mac}"
MON_MAC="${monitor_mac}"
MGMT_GW="${mgmt_gw}"
MGMT_CIDR="${mgmt_cidr}"

# Force legacy eth0/eth1 naming so corelightctl.yaml (which names eth0/eth1) matches. Takes
# effect after the next reboot; the sensor deploy reboots once, so names are eth0/eth1 by the
# time corelightctl runs. Ordering by MAC below is name-agnostic, so this can't break us early.
grubby --update-kernel=ALL --args="net.ifnames=0 biosdevname=0" 2>/dev/null || true

iface_for_mac() {
  local want="$1" d
  for d in /sys/class/net/*; do
    if [ "$(cat "$d/address" 2>/dev/null)" = "$want" ]; then basename "$d"; return 0; fi
  done
  return 1
}

# Persistent, name-agnostic routing policy via a NetworkManager dispatcher (re-runs on every
# ifup, so it survives the deploy reboot). The management ENI owns the default route; the
# monitoring ENI must never carry a default route (its subnet has no internet).
install -d /etc/NetworkManager/dispatcher.d
cat > /etc/NetworkManager/dispatcher.d/50-corelight-routes <<'DISP'
#!/bin/bash
IFACE="$1"; ACTION="$2"
[ "$ACTION" = "up" ] || [ "$ACTION" = "dhcp4-change" ] || exit 0
MGMT_MAC="__MGMT_MAC__"
MON_MAC="__MON_MAC__"
MGMT_GW="__MGMT_GW__"
mac=$(cat "/sys/class/net/$IFACE/address" 2>/dev/null)
case "$mac" in
  "$MGMT_MAC")
    ip route replace default via "$MGMT_GW" dev "$IFACE" metric 100
    ;;
  "$MON_MAC")
    ip route del default dev "$IFACE" 2>/dev/null || true
    ;;
esac
DISP
sed -i \
  -e "s|__MGMT_MAC__|$MGMT_MAC|g" \
  -e "s|__MON_MAC__|$MON_MAC|g" \
  -e "s|__MGMT_GW__|$MGMT_GW|g" \
  /etc/NetworkManager/dispatcher.d/50-corelight-routes
chmod 0755 /etc/NetworkManager/dispatcher.d/50-corelight-routes

# Ensure each ENI has an autoconnecting DHCP connection. Bind it to the MAC (not the interface
# name) so the connection follows the device across the eth0/eth1 rename.
ensure_con() {
  local mac="$1" name="$2" never_default="$3" metric="$4" ifn con
  ifn=$(iface_for_mac "$mac") || return 0
  con=$(nmcli -t -g GENERAL.CONNECTION device show "$ifn" 2>/dev/null | head -1)
  if [ -z "$con" ]; then
    nmcli connection add type ethernet con-name "$name" ifname "*" \
      802-3-ethernet.mac-address "$mac" ipv4.method auto ipv6.method disabled \
      connection.autoconnect yes ipv4.never-default "$never_default" ipv4.route-metric "$metric" || return 0
    con="$name"
  else
    nmcli connection modify "$con" ipv4.never-default "$never_default" ipv4.route-metric "$metric" connection.autoconnect yes || true
  fi
  nmcli device reapply "$ifn" 2>/dev/null || nmcli connection up "$con" 2>/dev/null || true
}

# Wait for both ENIs to appear (secondary ENIs can lag on boot).
for _ in $(seq 1 30); do
  iface_for_mac "$MGMT_MAC" >/dev/null && iface_for_mac "$MON_MAC" >/dev/null && break
  sleep 2
done

ensure_con "$MON_MAC"  corelight-monitor yes 200
ensure_con "$MGMT_MAC" corelight-mgmt    no  100

# Apply the dispatcher to interfaces that are already up.
for d in /sys/class/net/*; do
  ifn=$(basename "$d")
  [ "$ifn" = "lo" ] && continue
  /etc/NetworkManager/dispatcher.d/50-corelight-routes "$ifn" up || true
done
