#include "assembled_server/SeedPhrase.h"

#include <openssl/hmac.h>

#include <array>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>

namespace assembled_server {

namespace {

// 256-word English wordlist (placeholder -- lore flavouring deferred to
// post-v1 per design/09-identity.md §5).  Source: first 256 entries from the
// BIP-39 English wordlist (MIT-licensed via Bitcoin Core).  Exactly 256 words
// so each can be indexed by one byte, giving 8 words × 8 bits = 64 bits of
// entropy -- matching the target in design §5.
constexpr std::array<std::string_view, 256> kWordlist = {{
    "abandon",  "ability",  "able",     "about",    "above",    "absent",
    "absorb",   "abstract", "absurd",   "abuse",    "access",   "accident",
    "account",  "accuse",   "achieve",  "acid",     "acoustic", "acquire",
    "across",   "act",      "action",   "actor",    "actress",  "actual",
    "adapt",    "add",      "addict",   "address",  "adjust",   "admit",
    "adult",    "advance",  "advice",   "aerobic",  "afford",   "afraid",
    "again",    "age",      "agent",    "agree",    "ahead",    "aim",
    "air",      "airport",  "aisle",    "alarm",    "album",    "alcohol",
    "alert",    "alien",    "all",      "alley",    "allow",    "almost",
    "alone",    "alpha",    "already",  "also",     "alter",    "always",
    "amateur",  "amazing",  "among",    "amount",   "amused",   "analyst",
    "anchor",   "ancient",  "anger",    "angle",    "angry",    "animal",
    "ankle",    "announce", "annual",   "another",  "answer",   "antenna",
    "antique",  "anxiety",  "any",      "apart",    "apology",  "appear",
    "apple",    "approve",  "april",    "arch",     "arctic",   "area",
    "arena",    "argue",    "arm",      "armed",    "armor",    "army",
    "around",   "arrange",  "arrest",   "arrive",   "arrow",    "art",
    "artefact", "artist",   "artwork",  "ask",      "aspect",   "assault",
    "asset",    "assist",   "assume",   "asthma",   "athlete",  "atom",
    "attack",   "attend",   "attitude", "attract",  "auction",  "audit",
    "august",   "aunt",     "author",   "auto",     "autumn",   "average",
    "avocado",  "avoid",    "awake",    "aware",    "away",     "awesome",
    "awful",    "awkward",  "axis",     "baby",     "balance",  "bamboo",
    "banana",   "banner",   "barely",   "bargain",  "barrel",   "base",
    "basic",    "basket",   "battle",   "beach",    "bean",     "beauty",
    "become",   "beef",     "before",   "begin",    "behave",   "behind",
    "believe",  "below",    "belt",     "bench",    "benefit",  "best",
    "betray",   "better",   "between",  "beyond",   "bicycle",  "bid",
    "bike",     "bind",     "biology",  "bird",     "birth",    "bitter",
    "black",    "blade",    "blame",    "blanket",  "blast",    "bleak",
    "bless",    "blind",    "blood",    "blossom",  "blouse",   "blue",
    "blur",     "blush",    "board",    "boat",     "body",     "boil",
    "bomb",     "bone",     "book",     "boost",    "border",   "boring",
    "borrow",   "boss",     "bottom",   "bounce",   "box",      "boy",
    "bracket",  "brain",    "brand",    "brave",    "breeze",   "brick",
    "bridge",   "brief",    "bright",   "bring",    "brisk",    "broccoli",
    "broken",   "bronze",   "broom",    "brother",  "brown",    "brush",
    "bubble",   "buddy",    "budget",   "buffalo",  "build",    "bulb",
    "bulk",     "bullet",   "bundle",   "bunker",   "burden",   "burger",
    "burst",    "bus",      "business", "busy",     "butter",   "buyer",
    "buzz",     "cabbage",  "cabin",    "cable",    "cactus",   "cage",
    "cake",     "call",     "calm",     "camera",   "camp",     "can",
    "canal",    "cancel",   "candy",    "cannon",
}};

static_assert(kWordlist.size() == 256, "wordlist must contain exactly 256 entries");

} // namespace

std::span<const std::string_view> SeedPhrase::wordlist() { return kWordlist; }

std::string SeedPhrase::generate() {
    // Use a non-deterministic seed so each call produces a fresh phrase.
    std::random_device rd;
    std::mt19937 rng(rd());
    std::uniform_int_distribution<size_t> dist(0, kWordlist.size() - 1);

    std::ostringstream oss;
    for (int i = 0; i < 8; ++i) {
        if (i > 0) {
            oss << ' ';
        }
        oss << kWordlist[dist(rng)];
    }
    return oss.str();
}

std::string SeedPhrase::deriveToken(const std::string &secret, const std::string &phrase) {
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int digestLen = 0;

    const auto *result = HMAC(
        EVP_sha256(),
        secret.data(), static_cast<int>(secret.size()),
        reinterpret_cast<const unsigned char *>(phrase.data()),
        static_cast<int>(phrase.size()),
        digest, &digestLen);

    if (result == nullptr) {
        throw std::runtime_error("HMAC-SHA256 failed");
    }

    std::ostringstream hex;
    hex << std::hex << std::setfill('0');
    for (unsigned int i = 0; i < digestLen; ++i) {
        hex << std::setw(2) << static_cast<unsigned int>(digest[i]);
    }
    return hex.str();
}

} // namespace assembled_server
