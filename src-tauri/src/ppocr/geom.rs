//! Plane geometry for the detector: convex hulls, the smallest rectangle around a blob, and the
//! corner order the text-line cropper expects.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

impl Point {
    pub fn new(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    pub fn distance(self, other: Point) -> f32 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

/// A rectangle of any orientation. `width` runs along the direction `angle` (radians), `height`
/// across it.
#[derive(Clone, Copy, Debug)]
pub struct RotatedRect {
    pub center: Point,
    pub width: f32,
    pub height: f32,
    pub angle: f32,
}

impl RotatedRect {
    pub fn min_side(&self) -> f32 {
        self.width.min(self.height)
    }

    pub fn area(&self) -> f32 {
        self.width * self.height
    }

    pub fn perimeter(&self) -> f32 {
        2.0 * (self.width + self.height)
    }

    /// The same rectangle, `by` larger on every side.
    pub fn grown(&self, by: f32) -> RotatedRect {
        RotatedRect {
            width: self.width + 2.0 * by,
            height: self.height + 2.0 * by,
            ..*self
        }
    }

    pub fn corners(&self) -> [Point; 4] {
        let (sin, cos) = self.angle.sin_cos();
        let (half_width, half_height) = (self.width / 2.0, self.height / 2.0);
        let corner = |along: f32, across: f32| {
            Point::new(
                self.center.x + along * cos - across * sin,
                self.center.y + along * sin + across * cos,
            )
        };
        [
            corner(-half_width, -half_height),
            corner(half_width, -half_height),
            corner(half_width, half_height),
            corner(-half_width, half_height),
        ]
    }

    /// Whether `point` is inside, or no further than `slack` outside.
    pub fn contains(&self, point: Point, slack: f32) -> bool {
        let (sin, cos) = self.angle.sin_cos();
        let (dx, dy) = (point.x - self.center.x, point.y - self.center.y);
        let along = dx * cos + dy * sin;
        let across = -dx * sin + dy * cos;
        along.abs() <= self.width / 2.0 + slack && across.abs() <= self.height / 2.0 + slack
    }
}

fn cross(origin: (i32, i32), a: (i32, i32), b: (i32, i32)) -> i64 {
    i64::from(a.0 - origin.0) * i64::from(b.1 - origin.1)
        - i64::from(a.1 - origin.1) * i64::from(b.0 - origin.0)
}

/// The corners of the smallest convex polygon around the points, counter-clockwise (y pointing
/// down, so clockwise on the screen). Fewer than three corners come back for fewer than three
/// distinct points or for points on one line.
pub fn convex_hull(mut points: Vec<(i32, i32)>) -> Vec<(i32, i32)> {
    points.sort_unstable();
    points.dedup();
    if points.len() <= 2 {
        return points;
    }
    let mut hull: Vec<(i32, i32)> = Vec::with_capacity(points.len().min(256));
    for &point in &points {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], point) <= 0 {
            hull.pop();
        }
        hull.push(point);
    }
    let lower = hull.len() + 1;
    for &point in points.iter().rev().skip(1) {
        while hull.len() >= lower && cross(hull[hull.len() - 2], hull[hull.len() - 1], point) <= 0 {
            hull.pop();
        }
        hull.push(point);
    }
    hull.pop();
    hull
}

/// The rectangle of the least area that holds every hull corner. One of its sides lies along an
/// edge of the hull, so each edge is tried in turn.
pub fn min_area_rect(hull: &[(i32, i32)]) -> Option<RotatedRect> {
    match hull {
        [] => None,
        [only] => Some(RotatedRect {
            center: Point::new(only.0 as f32, only.1 as f32),
            width: 0.0,
            height: 0.0,
            angle: 0.0,
        }),
        [first, last] => {
            let (dx, dy) = ((last.0 - first.0) as f32, (last.1 - first.1) as f32);
            Some(RotatedRect {
                center: Point::new(
                    (first.0 + last.0) as f32 / 2.0,
                    (first.1 + last.1) as f32 / 2.0,
                ),
                width: dx.hypot(dy),
                height: 0.0,
                angle: dy.atan2(dx),
            })
        }
        _ => {
            let mut best: Option<(f64, RotatedRect)> = None;
            for (index, &from) in hull.iter().enumerate() {
                let to = hull[(index + 1) % hull.len()];
                let (dx, dy) = (f64::from(to.0 - from.0), f64::from(to.1 - from.1));
                let length = dx.hypot(dy);
                if length == 0.0 {
                    continue;
                }
                let (ux, uy) = (dx / length, dy / length);
                let (vx, vy) = (-uy, ux);
                let (mut min_u, mut max_u) = (f64::MAX, f64::MIN);
                let (mut min_v, mut max_v) = (f64::MAX, f64::MIN);
                for point in hull {
                    let (rx, ry) = (f64::from(point.0 - from.0), f64::from(point.1 - from.1));
                    let (u, v) = (rx * ux + ry * uy, rx * vx + ry * vy);
                    min_u = min_u.min(u);
                    max_u = max_u.max(u);
                    min_v = min_v.min(v);
                    max_v = max_v.max(v);
                }
                let (width, height) = (max_u - min_u, max_v - min_v);
                let area = width * height;
                if best
                    .as_ref()
                    .is_some_and(|(least, _)| area >= *least - 1e-6)
                {
                    continue;
                }
                let (mid_u, mid_v) = ((min_u + max_u) / 2.0, (min_v + max_v) / 2.0);
                best = Some((
                    area,
                    RotatedRect {
                        center: Point::new(
                            (f64::from(from.0) + mid_u * ux + mid_v * vx) as f32,
                            (f64::from(from.1) + mid_u * uy + mid_v * vy) as f32,
                        ),
                        width: width as f32,
                        height: height as f32,
                        angle: uy.atan2(ux) as f32,
                    },
                ));
            }
            best.map(|(_, rect)| rect)
        }
    }
}

/// The four corners as top-left, top-right, bottom-right, bottom-left: the two on the left by
/// height, then the two on the right by height.
pub fn order_corners(corners: [Point; 4]) -> [Point; 4] {
    let mut by_x = corners;
    by_x.sort_by(|a, b| a.x.total_cmp(&b.x));
    let (left_top, left_bottom) = if by_x[0].y <= by_x[1].y {
        (by_x[0], by_x[1])
    } else {
        (by_x[1], by_x[0])
    };
    let (right_top, right_bottom) = if by_x[2].y <= by_x[3].y {
        (by_x[2], by_x[3])
    } else {
        (by_x[3], by_x[2])
    };
    [left_top, right_top, right_bottom, left_bottom]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn the_hull_of_a_filled_square_is_its_four_corners() {
        let mut points = Vec::new();
        for y in 0..5 {
            for x in 0..5 {
                points.push((x, y));
            }
        }

        let hull = convex_hull(points);

        assert_eq!(hull.len(), 4);
        for corner in [(0, 0), (4, 0), (4, 4), (0, 4)] {
            assert!(hull.contains(&corner), "{corner:?} missing from {hull:?}");
        }
    }

    #[test]
    fn points_on_one_line_have_a_hull_of_their_two_ends() {
        let hull = convex_hull(vec![(0, 0), (3, 3), (1, 1), (2, 2)]);

        assert_eq!(hull, vec![(0, 0), (3, 3)]);
    }

    #[test]
    fn a_single_point_and_no_point_have_no_polygon() {
        assert_eq!(convex_hull(vec![(2, 2), (2, 2)]), vec![(2, 2)]);
        assert!(convex_hull(Vec::new()).is_empty());
        assert!(min_area_rect(&[]).is_none());
    }

    #[test]
    fn the_smallest_rectangle_around_an_upright_box_is_that_box() {
        let hull = convex_hull(vec![(10, 5), (60, 5), (60, 25), (10, 25)]);

        let rect = min_area_rect(&hull).unwrap();

        assert!(close(rect.area(), 50.0 * 20.0), "{rect:?}");
        assert!(close(rect.min_side(), 20.0), "{rect:?}");
        assert!(
            close(rect.center.x, 35.0) && close(rect.center.y, 15.0),
            "{rect:?}"
        );
    }

    #[test]
    fn the_smallest_rectangle_around_a_tilted_box_follows_the_tilt() {
        // A 400 by 100 box turned by 30 degrees, corners rounded to whole pixels.
        let angle = 30.0f32.to_radians();
        let (sin, cos) = angle.sin_cos();
        let corner = |along: f32, across: f32| {
            (
                (500.0 + along * cos - across * sin).round() as i32,
                (500.0 + along * sin + across * cos).round() as i32,
            )
        };
        let hull = convex_hull(vec![
            corner(-200.0, -50.0),
            corner(200.0, -50.0),
            corner(200.0, 50.0),
            corner(-200.0, 50.0),
        ]);

        let rect = min_area_rect(&hull).unwrap();

        assert!((rect.area() - 40_000.0).abs() < 1_500.0, "{rect:?}");
        assert!((rect.min_side() - 100.0).abs() < 3.0, "{rect:?}");
        assert!(
            (rect.width.max(rect.height) - 400.0).abs() < 3.0,
            "{rect:?}"
        );
    }

    #[test]
    fn a_growing_rectangle_keeps_its_centre_and_direction() {
        let rect = RotatedRect {
            center: Point::new(50.0, 20.0),
            width: 40.0,
            height: 10.0,
            angle: 0.0,
        };

        let grown = rect.grown(3.0);

        assert!(close(grown.width, 46.0) && close(grown.height, 16.0));
        assert_eq!(grown.center, rect.center);
        let corners = grown.corners();
        assert!(
            close(corners[0].x, 27.0) && close(corners[0].y, 12.0),
            "{corners:?}"
        );
        assert!(
            close(corners[2].x, 73.0) && close(corners[2].y, 28.0),
            "{corners:?}"
        );
    }

    #[test]
    fn a_point_is_inside_a_rectangle_up_to_the_slack() {
        let rect = RotatedRect {
            center: Point::new(10.0, 10.0),
            width: 20.0,
            height: 10.0,
            angle: 0.0,
        };

        assert!(rect.contains(Point::new(0.0, 5.0), 0.0));
        assert!(rect.contains(Point::new(20.0, 15.0), 0.0));
        assert!(!rect.contains(Point::new(20.5, 15.0), 0.0));
        assert!(rect.contains(Point::new(20.5, 15.0), 0.6));
    }

    #[test]
    fn corners_are_put_in_reading_order_whatever_order_they_come_in() {
        let corners = [
            Point::new(60.0, 30.0),
            Point::new(10.0, 5.0),
            Point::new(10.0, 30.0),
            Point::new(60.0, 5.0),
        ];

        let ordered = order_corners(corners);

        assert_eq!(ordered[0], Point::new(10.0, 5.0));
        assert_eq!(ordered[1], Point::new(60.0, 5.0));
        assert_eq!(ordered[2], Point::new(60.0, 30.0));
        assert_eq!(ordered[3], Point::new(10.0, 30.0));
    }
}
