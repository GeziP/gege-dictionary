use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_IMPORT_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMPORT_ROWS: usize = 10_000;
const ALLOWED_IMPORT_TARGETS: &[&str] = &[
    "lemma",
    "translation",
    "pos",
    "contextMeaning",
    "explanation",
    "note",
    "tags",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportRowError {
    pub row: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordImportPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub errors: Vec<ImportRowError>,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WordImportResult {
    pub inserted: u32,
    pub merged: u32,
    pub skipped: u32,
    pub errors: Vec<ImportRowError>,
}

#[derive(Debug, Clone)]
pub struct ParsedImportRow {
    pub row: usize,
    pub fields: HashMap<String, String>,
    pub tags: Vec<String>,
}

fn delimiter(format: &str) -> Result<u8, String> {
    match format.to_ascii_lowercase().as_str() {
        "csv" => Ok(b','),
        "tsv" => Ok(b'\t'),
        other => Err(format!("不支持的导入格式: {other}")),
    }
}

fn reader<'a>(content: &'a str, format: &str) -> Result<csv::Reader<&'a [u8]>, String> {
    if content.len() > MAX_IMPORT_BYTES {
        return Err("导入文件不能超过 10 MB".into());
    }
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    Ok(csv::ReaderBuilder::new()
        .delimiter(delimiter(format)?)
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes()))
}

pub fn preview_word_import(content: &str, format: &str) -> Result<WordImportPreview, String> {
    let mut reader = reader(content, format)?;
    let columns = reader
        .headers()
        .map_err(|e| format!("读取导入列名失败: {e}"))?
        .iter()
        .map(|column| column.trim().to_string())
        .collect::<Vec<_>>();
    if columns.is_empty() || columns.iter().all(String::is_empty) {
        return Err("导入文件必须包含列名".into());
    }
    let lemma_index = columns
        .iter()
        .position(|column| column.eq_ignore_ascii_case("lemma"));
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let mut total_rows = 0;
    for (index, record) in reader.records().enumerate() {
        total_rows += 1;
        if total_rows > MAX_IMPORT_ROWS {
            return Err("导入文件不能超过 10,000 行".into());
        }
        let row_number = index + 2;
        match record {
            Ok(record) => {
                let values = record.iter().map(ToString::to_string).collect::<Vec<_>>();
                if rows.len() < 10 {
                    rows.push(values.clone());
                }
                if values.len() != columns.len() {
                    errors.push(ImportRowError {
                        row: row_number,
                        message: format!("列数为 {}，应为 {}", values.len(), columns.len()),
                    });
                } else if let Some(lemma_index) = lemma_index {
                    if values
                        .get(lemma_index)
                        .map(|value| value.trim())
                        .unwrap_or("")
                        .is_empty()
                    {
                        errors.push(ImportRowError {
                            row: row_number,
                            message: "lemma 不能为空".into(),
                        });
                    }
                }
            }
            Err(error) => errors.push(ImportRowError {
                row: row_number,
                message: format!("CSV/TSV 格式错误: {error}"),
            }),
        }
    }
    Ok(WordImportPreview {
        columns,
        rows,
        total_rows,
        errors,
        format: format.to_ascii_lowercase(),
    })
}

pub fn parse_import_rows(
    content: &str,
    format: &str,
    mapping: &HashMap<String, String>,
) -> Result<(Vec<ParsedImportRow>, Vec<ImportRowError>), String> {
    for target in mapping.keys() {
        if !ALLOWED_IMPORT_TARGETS.contains(&target.as_str()) {
            return Err(format!("不允许的导入映射字段: {target}"));
        }
    }
    let lemma_column = mapping
        .get("lemma")
        .filter(|value| !value.trim().is_empty())
        .ok_or("必须映射 lemma 列")?
        .to_string();
    let mut reader = reader(content, format)?;
    let columns = reader
        .headers()
        .map_err(|e| format!("读取导入列名失败: {e}"))?
        .iter()
        .map(|column| column.trim().to_string())
        .collect::<Vec<_>>();
    if !columns.iter().any(|column| column == &lemma_column) {
        return Err(format!("找不到映射列: {lemma_column}"));
    }
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    for (index, record) in reader.records().enumerate() {
        if index >= MAX_IMPORT_ROWS {
            return Err("导入文件不能超过 10,000 行".into());
        }
        let row_number = index + 2;
        let record = match record {
            Ok(record) => record,
            Err(error) => {
                errors.push(ImportRowError {
                    row: row_number,
                    message: format!("CSV/TSV 格式错误: {error}"),
                });
                continue;
            }
        };
        if record.len() != columns.len() {
            errors.push(ImportRowError {
                row: row_number,
                message: format!("列数为 {}，应为 {}", record.len(), columns.len()),
            });
            continue;
        }
        let values = columns
            .iter()
            .zip(record.iter())
            .map(|(column, value)| (column.clone(), value.trim().to_string()))
            .collect::<HashMap<_, _>>();
        let lemma = values.get(&lemma_column).map(String::as_str).unwrap_or("");
        if lemma.trim().is_empty() {
            errors.push(ImportRowError {
                row: row_number,
                message: "lemma 不能为空".into(),
            });
            continue;
        }
        let mut fields = HashMap::new();
        for (target, source) in mapping {
            if target == "tags" || target == "lemma" {
                continue;
            }
            if let Some(value) = values.get(source) {
                fields.insert(target.clone(), value.clone());
            }
        }
        let tags = mapping
            .get("tags")
            .and_then(|source| values.get(source))
            .map(|value| {
                value
                    .split([';', '|', ','])
                    .map(|tag| tag.trim())
                    .filter(|tag| !tag.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        fields.insert("lemma".into(), lemma.to_string());
        rows.push(ParsedImportRow {
            row: row_number,
            fields,
            tags,
        });
    }
    Ok((rows, errors))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_supports_bom_quotes_newlines_and_row_errors() {
        let content = "\u{feff}lemma,translation\n\"New, York\",\"line one\nline two\"\n,missing\n";
        let preview = preview_word_import(content, "csv").unwrap();
        assert_eq!(preview.columns, vec!["lemma", "translation"]);
        assert_eq!(preview.total_rows, 2);
        assert_eq!(preview.rows[0][0], "New, York");
        assert_eq!(preview.errors[0].row, 3);
    }

    #[test]
    fn parser_rejects_oversized_files_and_more_than_ten_thousand_rows() {
        let content = "lemma\n".to_string() + &"word\n".repeat(10_001);
        let error = preview_word_import(&content, "tsv").unwrap_err();
        assert!(error.contains("10,000"));
    }

    #[test]
    fn parser_rejects_more_than_ten_thousand_rows_without_preview() {
        let content = "lemma\n".to_string() + &"word\n".repeat(10_001);
        let mapping = [("lemma".to_string(), "lemma".to_string())]
            .into_iter()
            .collect();
        let error = parse_import_rows(&content, "tsv", &mapping).unwrap_err();
        assert!(error.contains("10,000"));
    }

    #[test]
    fn parser_rejects_internal_mapping_targets() {
        let mapping = [("id".to_string(), "lemma".to_string())]
            .into_iter()
            .collect();
        let error = parse_import_rows("lemma\nhello\n", "csv", &mapping).unwrap_err();
        assert!(error.contains("映射") || error.contains("target") || error.contains("字段"));
    }
}
