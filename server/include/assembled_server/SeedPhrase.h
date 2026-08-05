#pragma once

#include <span>
#include <string>
#include <string_view>

namespace assembled_server {

/// Seed-phrase generation and deterministic token derivation (T-0094).
///
/// The model is described in docs/design/09-identity.md §1:
///   - Server generates a phrase, derives a token, **discards the phrase**.
///   - Only the token is ever stored; a DB dump must not expose identities.
///   - The phrase is English, non-localized, fixed wordlist (S-2 resolved
///     to 256 words for 64-bit entropy with 8 words per phrase).
///
/// Wordlist note: 256-word placeholder list, uniform-random draw per §5.
/// Lore-flavoured wordlist is post-v1 (design §5); this list is stable for
/// the wire format but not for the in-world aesthetic.
class SeedPhrase {
  public:
    /// @return the fixed 256-word English wordlist.  Returned as a span of
    ///         string_view so callers can iterate without heap allocation.
    static std::span<const std::string_view> wordlist();

    /// Generates a seed phrase by drawing 8 words uniformly at random from
    /// the wordlist (design §5: 8 words × 256-word list = 64-bit entropy).
    /// Uses a cryptographically-seeded RNG.
    /// @return space-separated phrase, e.g. "cable dust mirror seven ...".
    static std::string generate();

    /// Derives a stable identity token from a phrase and a server secret.
    /// Uses HMAC-SHA256(secret, phrase) hex-encoded to 64 characters.
    /// Deterministic: the same (secret, phrase) pair always yields the same
    /// token; different phrases yield different tokens with overwhelming
    /// probability.
    /// @param secret  HMAC key (read from IDENTITY_SECRET env var in prod;
    ///                callers supply it explicitly to allow test injection).
    /// @param phrase  the 8-word space-separated seed phrase.
    /// @return 64-character lowercase hex string.
    static std::string deriveToken(const std::string &secret, const std::string &phrase);
};

} // namespace assembled_server
