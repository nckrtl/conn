//! Native ACP form fields and Antigravity's legacy permission-shaped questions.
use crate::ordered::{J, obj};
use serde_json::{Map, Value, json};

fn choices(schema: &Value) -> Option<Vec<Value>> {
    let entries = schema["enum"]
        .as_array()
        .or_else(|| schema["oneOf"].as_array())
        .or_else(|| schema["anyOf"].as_array())?;
    let mut seen = std::collections::HashSet::new();
    entries
        .iter()
        .map(|entry| {
            let value = entry.as_str().or_else(|| entry["const"].as_str())?;
            let label = entry["title"].as_str().unwrap_or(value);
            (!value.is_empty() && seen.insert(value))
                .then(|| json!({"value":value,"label":label,"description":label}))
        })
        .collect()
}

pub(crate) fn form_questions(schema: &Value, message: &str) -> Option<Value> {
    if schema["type"] != "object" {
        return None;
    }
    let mut questions = Vec::new();
    for (key, property) in schema["properties"].as_object()? {
        let kind = property["type"].as_str()?;
        let options = match kind {
            "boolean" => vec![
                json!({"label":"Yes","value":"true","description":"Yes"}),
                json!({"label":"No","value":"false","description":"No"}),
            ],
            "string" if !property["enum"].is_null() || !property["oneOf"].is_null() => {
                choices(property)?
            }
            "array" => choices(&property["items"])?,
            "string" | "integer" | "number" => Vec::new(),
            _ => return None,
        };
        let required = schema["required"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == key));
        let header = property["title"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Question {}", questions.len() + 1));
        let mut q = json!({"id":key,"header":header,"question":property["description"].as_str().unwrap_or(message),"options":options});
        if !options.is_empty() {
            q["allowCustomAnswer"] = json!(false);
        }
        if kind == "array" {
            q["multiSelect"] = json!(true);
        }
        if !required && kind == "string" && options.is_empty() {
            q["required"] = json!(false);
        }
        questions.push(q);
    }
    (!questions.is_empty()).then_some(Value::Array(questions))
}

fn typed(property: &Value, answer: &Value) -> Option<Value> {
    let text = answer.as_str().or_else(|| {
        answer
            .as_array()
            .filter(|a| a.len() == 1)
            .and_then(|a| a[0].as_str())
    });
    match property["type"].as_str()? {
        "integer" => Some(json!(text?.trim().parse::<i64>().ok()?)),
        "number" => serde_json::Number::from_f64(text?.trim().parse().ok()?).map(Value::Number),
        "boolean" => match text? {
            "true" | "Yes" => Some(json!(true)),
            "false" | "No" => Some(json!(false)),
            _ => None,
        },
        "string" => {
            let t = text?;
            if (property["enum"].is_array() || property["oneOf"].is_array())
                && !choices(property)?.iter().any(|c| c["value"] == t)
            {
                return None;
            }
            Some(json!(t))
        }
        "array" => {
            let selected = answer.as_array()?;
            let valid = choices(&property["items"])?;
            let mut values = Vec::new();
            for value in selected {
                if !valid.iter().any(|c| c["value"] == *value) {
                    return None;
                }
                if !values.contains(value) {
                    values.push(value.clone());
                }
            }
            let n = values.len() as u64;
            (n >= property["minItems"].as_u64().unwrap_or(0)
                && n <= property["maxItems"].as_u64().unwrap_or(u64::MAX))
            .then_some(Value::Array(values))
        }
        _ => None,
    }
}

pub(crate) fn form_response(schema: &Value, answers: Option<&Value>) -> J {
    let cancel = || obj().with("action", "cancel");
    let Some(answers) = answers else {
        return cancel();
    };
    let Some(fields) = schema["properties"].as_object() else {
        return cancel();
    };
    let mut content = Map::new();
    for (id, field) in fields {
        if let Some(value) = answers.get(id).and_then(|v| typed(field, v)) {
            content.insert(id.clone(), value);
        } else if schema["required"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == id))
        {
            return cancel();
        }
    }
    obj()
        .with("action", "accept")
        .with("content", Value::Object(content))
}

pub(crate) fn permission_question(params: &Value) -> Option<Value> {
    let key = params["toolCall"]["toolCallId"].as_str()?;
    let mut seen = std::collections::HashSet::new();
    let options: Option<Vec<_>> = params["options"]
        .as_array()?
        .iter()
        .map(|opt| {
            let id = opt["optionId"].as_str()?;
            if id.trim().is_empty() || !seen.insert(id) {
                return None;
            }
            let label = opt["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id);
            let label = if label.chars().count() > 512 {
                format!("{}...", label.chars().take(509).collect::<String>())
            } else {
                label.to_owned()
            };
            Some(json!({"value":id,"label":label,"description":label}))
        })
        .collect();
    let options = options?;
    if options.is_empty() {
        return None;
    }
    let question = params["toolCall"]["title"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Choose an option.");
    Some(
        json!([{"id":key,"header":"Question","question":question,"options":options,"multiSelect":false,"allowCustomAnswer":false}]),
    )
}

pub(crate) fn permission_response(questions: &Value, answers: Option<&Value>) -> J {
    let id = (|| {
        let q = &questions[0];
        let response = answers?.get(q["id"].as_str()?)?;
        let value = response.as_str().or_else(|| {
            response
                .as_array()
                .filter(|a| a.len() == 1)
                .and_then(|a| a[0].as_str())
        })?;
        let options = q["options"].as_array()?;
        if let Some(opt) = options.iter().find(|o| o["value"] == value) {
            return opt["value"].as_str();
        }
        let mut matches = options.iter().filter(|o| o["label"] == value);
        let first = matches.next()?;
        matches
            .next()
            .is_none()
            .then(|| first["value"].as_str())
            .flatten()
    })();
    match id {
        Some(id) => obj().with(
            "outcome",
            obj().with("outcome", "selected").with("optionId", id),
        ),
        None => obj().with("outcome", obj().with("outcome", "cancelled")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn option_ids_take_precedence_over_ambiguous_labels() {
        let q=permission_question(&json!({"toolCall":{"toolCallId":"interaction_1"},"options":[{"optionId":"1","kind":"allow_once","name":"Yes"},{"optionId":"2","kind":"allow_once","name":"Yes"}]})).unwrap();
        assert_eq!(
            permission_response(&q, Some(&json!({"interaction_1":"2"}))).to_line(),
            r#"{"outcome":{"outcome":"selected","optionId":"2"}}"#
        );
        assert_eq!(
            permission_response(&q, Some(&json!({"interaction_1":"Yes"}))).to_line(),
            r#"{"outcome":{"outcome":"cancelled"}}"#
        );
    }
    #[test]
    fn form_preserves_types_and_rejects_unknown_selections() {
        let s = json!({"type":"object","properties":{"number":{"type":"integer"},"pick":{"type":"string","enum":["a","b"]}},"required":["number","pick"]});
        assert!(form_questions(&s, "Select").is_some());
        assert_eq!(
            form_response(&s, Some(&json!({"number":"23","pick":"b"}))).to_line(),
            r#"{"action":"accept","content":{"number":23,"pick":"b"}}"#
        );
        assert_eq!(
            form_response(&s, Some(&json!({"number":"23","pick":"other"}))).to_line(),
            r#"{"action":"cancel"}"#
        );
    }
}
