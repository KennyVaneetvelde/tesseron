#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <tesseron/json.hpp>

namespace tesseron {

/// One thing an invocation input got wrong, as it appears in the `data` member
/// of a `-32004 InputValidation` failure.
struct ValidationIssue {
  std::string message;
  /// Location inside the input, outermost key first. Empty when the whole input
  /// is wrong.
  std::vector<std::string> path;

  [[nodiscard]] Json to_json() const;
};

/// The `data` payload for a `-32004` failure: the issues as a bare array, which
/// is the shape the error catalog pins.
[[nodiscard]] Json validation_issues_to_json(const std::vector<ValidationIssue>& issues);

/// One declared shape, published as JSON Schema and enforced at dispatch.
///
/// The same object answers both questions, so the contract the agent reads and
/// the contract the handler is protected by cannot drift apart. Build one with
/// the free functions in `tesseron::schema`.
class Schema {
 public:
  enum class Kind { Any, String, Number, Integer, Boolean, Object, Array };

  Schema() = default;

  Schema& description(std::string description);
  Schema& min_length(std::size_t characters);
  Schema& max_length(std::size_t characters);
  Schema& minimum(double bound);
  Schema& maximum(double bound);
  Schema& min_items(std::size_t items);
  Schema& max_items(std::size_t items);
  Schema& allowed_values(std::vector<Json> values);
  Schema& default_value(Json value);

  [[nodiscard]] Kind kind() const noexcept { return kind_; }

  /// The JSON Schema published in the manifest.
  [[nodiscard]] Json to_json() const;

  /// Every way `input` fails this schema. An empty result means it passes.
  [[nodiscard]] std::vector<ValidationIssue> validate(const Json& input) const;

 private:
  friend class SchemaFactory;

  struct Property {
    std::string name;
    std::shared_ptr<const Schema> schema;
    bool required = false;
  };

  void collect(const Json& input, std::vector<std::string>& path,
               std::vector<ValidationIssue>& issues) const;

  Kind kind_ = Kind::Any;
  std::optional<std::string> description_;
  std::optional<std::size_t> min_length_;
  std::optional<std::size_t> max_length_;
  std::optional<double> minimum_;
  std::optional<double> maximum_;
  std::optional<std::size_t> min_items_;
  std::optional<std::size_t> max_items_;
  std::optional<std::vector<Json>> allowed_values_;
  std::optional<Json> default_value_;
  std::vector<Property> properties_;
  std::shared_ptr<const Schema> items_;
};

/// One entry in an object schema, produced by `schema::required` or
/// `schema::optional`.
struct SchemaProperty {
  std::string name;
  Schema schema;
  bool required = false;
};

/// The declaration vocabulary.
///
/// ```cpp
/// schema::object({
///     schema::required("text", schema::string().min_length(1)),
///     schema::optional("tag", schema::string()),
/// })
/// ```
namespace schema {

[[nodiscard]] Schema any();
[[nodiscard]] Schema string();
[[nodiscard]] Schema number();
[[nodiscard]] Schema integer();
[[nodiscard]] Schema boolean();
[[nodiscard]] Schema array(Schema items);
[[nodiscard]] Schema object(std::vector<SchemaProperty> properties);

[[nodiscard]] SchemaProperty required(std::string name, Schema schema);
[[nodiscard]] SchemaProperty optional(std::string name, Schema schema);

}  // namespace schema

}  // namespace tesseron
